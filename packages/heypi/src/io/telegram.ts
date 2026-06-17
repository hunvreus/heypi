import { timingSafeEqual } from "node:crypto";
import { readFile } from "node:fs/promises";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { PermissionsConfig } from "../config.js";
import { approvalStateLine, approvalStateTitle, codeFence } from "../core/approval-view.js";
import { COMMANDS } from "../core/commands.js";
import { message as errorMessage, type Logger, userError } from "../core/log.js";
import type { AppMessages } from "../core/messages.js";
import type { ScopedKey } from "../core/scope.js";
import { chunkText } from "../render/chunk.js";
import { resolveOutboundAttachments, saveInboundAttachments } from "./attachment-policy.js";
import { type Attachment, type AttachmentStore, type ResolvedAttachment, responseBytes } from "./attachments.js";
import { runChatMessage } from "./chat-message.js";
import { validateAdapterConfig, warnAdapterConfig } from "./config-validation.js";
import { type DeliveryConfig, DeliveryQueue } from "./delivery.js";
import { allowByDimensions, messageTriggered } from "./gate.js";
import type { Adapter, AdapterStart, AdapterTarget, Handler, Outbound } from "./handler.js";
import { logCtx } from "./log-context.js";
import { assertRouteName } from "./name.js";
import { DraftReplyStream, type ReplyStreamOption } from "./reply-stream.js";

const APPROVE = "approve";
const DENY = "deny";
const CANCEL = "cancel";
const STATUS = "status";
const TELEGRAM_TEXT_LIMIT = 4096;
const TELEGRAM_CALLBACK_LIMIT = 200;
const TELEGRAM_CONFIG_KEYS = new Set([
	"name",
	"token",
	"apiUrl",
	"mode",
	"webhook",
	"pollTimeoutSeconds",
	"allow",
	"permissions",
	"trigger",
	"threadTrigger",
	"response",
	"progress",
	"streaming",
	"delivery",
]);

export type TelegramConfig = {
	name?: string;
	token: string;
	apiUrl?: { override: string };
	mode?: "polling" | "webhook";
	webhook?: TelegramWebhookConfig;
	pollTimeoutSeconds?: number;
	allow?: TelegramAllow;
	permissions?: PermissionsConfig;
	trigger?: TelegramTrigger;
	threadTrigger?: TelegramTrigger | false;
	response?: TelegramResponseConfig;
	progress?: TelegramProgress | false;
	streaming?: ReplyStreamOption;
	delivery?: DeliveryConfig | false;
};

export type TelegramWebhookConfig = {
	path?: string;
	unsafePathOverride?: boolean;
	secretToken?: string;
	port?: number | string;
	maxBodyBytes?: number;
};

export type TelegramTrigger = "mention" | "message";

export type TelegramResponseConfig = {
	placement?: "auto" | "same" | "reply";
	continueRecentMs?: number | false;
};

export type TelegramAllow = {
	chats?: Array<string | number>;
	users?: Array<string | number>;
	bots?: true | Array<string | number>;
	dms?: boolean;
};

export type TelegramProgress = {
	message?: string | false;
	delayMs?: number;
};

/** Creates a Telegram long-polling adapter. */
export function telegram(input: TelegramConfig): Adapter {
	const name = input.name ?? "telegram";
	assertRouteName(name);
	const configValidation = validateAdapterConfig(name, input, TELEGRAM_CONFIG_KEYS);
	const setup = telegramSetup(input, name);
	const kind = "telegram";
	const client = new TelegramClient(input.token, input.apiUrl);
	let stopped = false;
	let loop: Promise<void> | undefined;
	let activeLogger: Logger | undefined;
	let delivery = new DeliveryQueue(input.delivery);

	return {
		name,
		kind,
		permissions: input.permissions,
		acceptsBots: botsConfigured(input.allow?.bots),
		async start(start: AdapterStart): Promise<void> {
			activeLogger = start.logger;
			delivery = new DeliveryQueue(input.delivery, start.logger);
			stopped = false;
			warnAdapterConfig(start.logger, name, configValidation);
			start.logger.info("adapter.start", { adapter: name, kind });
			if (!telegramAllowConfigured(input.allow)) {
				start.logger.warn("security.adapter_allow_missing", {
					adapter: name,
					kind,
					reason: "without allow, delivered DMs and mentioned group messages can trigger the agent",
				});
			}
			if (input.apiUrl) start.logger.warn("telegram.api_url_override", { adapter: name, kind });
			const identity = await client.getMe().catch((error) => {
				start.logger.warn("telegram.get_me_failed", {
					adapter: name,
					kind,
					error: errorMessage(error),
				});
				return undefined;
			});
			await registerTelegramCommands(client, start.logger, { adapter: name, kind });
			if (setup.mode === "webhook") {
				registerTelegramWebhookRoute({
					start,
					setup,
					client,
					config: input,
					delivery,
					provider: name,
					kind,
					botUsername: identity?.username,
					botId: identity?.id,
				});
			} else {
				loop = poll({
					client,
					start,
					config: input,
					delivery,
					provider: name,
					kind,
					stopped: () => stopped,
					botUsername: identity?.username,
					botId: identity?.id,
				});
			}
		},
		async stop(): Promise<void> {
			stopped = true;
			await loop;
			activeLogger?.info("adapter.stop", { adapter: name, kind });
		},
		async send(target: AdapterTarget, out: Outbound, start?: AdapterStart): Promise<void> {
			const chatId = telegramTargetChat(target);
			const threadId = numberOrUndefined(target.thread);
			const log = start?.logger ?? activeLogger;
			const context = { adapter: name, kind, channel: String(chatId), thread: target.thread };
			await sendTargetChunks({
				client,
				chatId,
				threadId,
				text: out.text,
				approval: out.approval,
				logger: log,
				context,
				delivery,
			});
			const upload = await uploadTelegramAttachments({
				client,
				store: start?.attachments,
				chatId,
				threadId,
				attachments: out.attachments,
				scope: out.attachmentScope,
				logger: log ?? noopLogger,
				context,
				delivery,
			});
			await postTelegramAttachmentUploadNotice({
				client,
				chatId,
				threadId,
				upload,
				context,
				delivery,
			});
			log?.debug("adapter.send", {
				adapter: name,
				kind,
				channel: String(chatId),
				thread: target.thread,
				chars: out.text.length,
			});
		},
	};
}

function telegramTargetChat(target: AdapterTarget): number {
	const raw = target.channel ?? target.user;
	if (!raw) throw new Error("Telegram scheduled target requires channel");
	const parsed = Number(raw);
	if (!Number.isFinite(parsed)) throw new Error(`Invalid Telegram channel: ${raw}`);
	return parsed;
}

function telegramAllowConfigured(allow: TelegramAllow | undefined): boolean {
	return Boolean(allow?.chats?.length || allow?.users?.length || botsConfigured(allow?.bots) || allow?.dms === false);
}

function telegramSetup(
	input: TelegramConfig,
	name: string,
):
	| { mode: "polling"; path?: undefined; port?: undefined; secretToken?: undefined; maxBodyBytes?: undefined }
	| { mode: "webhook"; path: string; port?: number | string; secretToken: string; maxBodyBytes: number } {
	if (input.mode !== undefined && input.mode !== "polling" && input.mode !== "webhook") {
		throw new Error('Telegram mode must be "polling" or "webhook"');
	}
	if (input.mode === "webhook") {
		const webhook = input.webhook ?? {};
		if (!webhook.secretToken) throw new Error("Telegram webhook mode requires webhook.secretToken");
		if (webhook.path && !webhook.unsafePathOverride) {
			throw new Error("Telegram webhook path override requires unsafePathOverride: true");
		}
		return {
			mode: "webhook",
			path: webhook.path ?? `/telegram/${name}/webhook`,
			port: webhook.port,
			secretToken: webhook.secretToken,
			maxBodyBytes: webhook.maxBodyBytes ?? 1_000_000,
		};
	}
	return { mode: "polling" };
}

function numberOrUndefined(input?: string): number | undefined {
	if (!input) return undefined;
	const parsed = Number(input);
	return Number.isFinite(parsed) ? parsed : undefined;
}

type TelegramWebhookRoute = {
	start: AdapterStart;
	setup: { mode: "webhook"; path: string; port?: number | string; secretToken: string; maxBodyBytes: number };
	client: TelegramClient;
	config: TelegramConfig;
	delivery: DeliveryQueue;
	provider: string;
	kind: string;
	botUsername?: string;
	botId?: number;
};

function registerTelegramWebhookRoute(input: TelegramWebhookRoute): void {
	if (!input.start.http) throw new Error("Telegram webhook mode requires the heypi HTTP registrar");
	input.start.http.register({
		method: "POST",
		path: input.setup.path,
		port: input.setup.port,
		handler: (req, res) => {
			void receiveTelegramWebhook(input, req, res);
		},
	});
	input.start.logger.info("telegram.webhook.start", {
		adapter: input.provider,
		kind: input.kind,
		path: input.setup.path,
		port: input.setup.port,
	});
}

async function receiveTelegramWebhook(
	input: TelegramWebhookRoute,
	req: IncomingMessage,
	res: ServerResponse,
): Promise<void> {
	try {
		if (req.method !== "POST") return json(res, 405, { ok: false, error: "method not allowed" });
		const token = req.headers["x-telegram-bot-api-secret-token"];
		if (!safeEqual(typeof token === "string" ? token : "", input.setup.secretToken))
			return json(res, 401, { ok: false, error: "unauthorized" });
		const update = (await readJson(req, input.setup.maxBodyBytes)) as TelegramUpdate;
		json(res, 200, { ok: true });
		void handleUpdate({
			client: input.client,
			start: input.start,
			config: input.config,
			delivery: input.delivery,
			provider: input.provider,
			kind: input.kind,
			update,
			stopped: () => false,
			botUsername: input.botUsername,
			botId: input.botId,
		}).catch((error) => {
			input.start.logger.error("telegram.webhook_update_failed", {
				adapter: input.provider,
				kind: input.kind,
				update: update.update_id,
				error: errorMessage(error),
			});
		});
	} catch (error) {
		input.start.logger.warn("telegram.webhook_bad_request", {
			adapter: input.provider,
			kind: input.kind,
			error: errorMessage(error),
		});
		json(res, 400, { ok: false, error: "bad request" });
	}
}

async function readJson(req: IncomingMessage, maxBytes: number): Promise<unknown> {
	const chunks: Buffer[] = [];
	let total = 0;
	for await (const chunk of req) {
		const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
		total += buffer.length;
		if (total > maxBytes) throw new Error("request body too large");
		chunks.push(buffer);
	}
	const raw = Buffer.concat(chunks).toString("utf8");
	return raw ? JSON.parse(raw) : {};
}

function safeEqual(left: string, right: string): boolean {
	const leftBytes = Buffer.from(left);
	const rightBytes = Buffer.from(right);
	return leftBytes.length === rightBytes.length && timingSafeEqual(leftBytes, rightBytes);
}

function json(res: ServerResponse, status: number, body: unknown): void {
	if (res.headersSent) return;
	res.writeHead(status, { "content-type": "application/json" });
	res.end(JSON.stringify(body));
}

async function registerTelegramCommands(
	client: TelegramClient,
	logger: Logger,
	context: { adapter: string; kind: string },
): Promise<void> {
	const commands = COMMANDS.map((command) => ({
		command: command.name,
		description: command.description,
	}));
	await client.setMyCommands({ commands }).catch((error) => {
		logger.warn("telegram.commands_register_failed", { ...context, error: errorMessage(error) });
	});
}

async function poll(input: {
	client: TelegramClient;
	start: AdapterStart;
	config: TelegramConfig;
	delivery: DeliveryQueue;
	provider: string;
	kind: string;
	stopped: () => boolean;
	botUsername?: string;
	botId?: number;
}): Promise<void> {
	let offset = 0;
	const timeout = input.config.pollTimeoutSeconds ?? 25;
	let backoffMs = 1000;
	while (!input.stopped()) {
		try {
			const updates = await input.client.getUpdates({ offset, timeout });
			for (const update of updates) {
				offset = Math.max(offset, update.update_id + 1);
				await handleUpdate({ ...input, update });
			}
			backoffMs = 1000;
		} catch (error) {
			input.start.logger.warn("telegram.poll_failed", {
				adapter: input.provider,
				kind: input.kind,
				error: errorMessage(error),
				retryMs: backoffMs,
			});
			await sleep(backoffMs);
			backoffMs = Math.min(backoffMs * 2, 60_000);
		}
	}
}

async function handleUpdate(input: {
	client: TelegramClient;
	start: AdapterStart;
	config: TelegramConfig;
	delivery: DeliveryQueue;
	provider: string;
	kind: string;
	update: TelegramUpdate;
	stopped: () => boolean;
	botUsername?: string;
	botId?: number;
}): Promise<void> {
	const callback = input.update.callback_query;
	if (callback) {
		await handleCallback({
			client: input.client,
			handler: input.start.handler,
			logger: input.start.logger,
			store: input.start.attachments,
			messages: input.start.messages,
			callback,
			delivery: input.delivery,
			provider: input.provider,
			kind: input.kind,
		});
		return;
	}
	const msg = input.update.message;
	if (!msg?.chat) return;
	const bot = msg.from?.is_bot ? String(msg.from.id) : undefined;
	const channel = String(msg.chat.id);
	const actor = String(msg.from?.id ?? "unknown");
	const trace = `telegram:${msg.message_id}`;
	const replyTo = telegramReplyTo(input.config.response, msg);
	const context = (extra?: Record<string, unknown>) =>
		logCtx({ trace, adapter: input.provider, kind: input.kind, channel }, extra);
	if (bot && !telegramBotAllowed(input.config.allow?.bots, bot, input.botId)) {
		input.start.logger.debug("adapter.drop", context({ actor, reason: "bot_not_allowed" }));
		return;
	}
	const allow = telegramAllowed(input.config.allow, {
		chat: channel,
		user: actor,
		bot,
		botSelf: input.botId,
		isDm: telegramDm(msg),
	});
	if (!allow.ok) {
		input.start.logger.debug(
			"adapter.drop",
			context({
				actor,
				reason: allow.reason,
			}),
		);
		return;
	}
	const rawText = textOf(msg);
	const text = stripTelegramMention(rawText, input.botUsername);
	const trigger = telegramTriggered(input.config.trigger, {
		text: rawText,
		isDm: telegramDm(msg),
		botUsername: input.botUsername,
		thread: Boolean(msg.message_thread_id),
		threadTrigger: input.config.threadTrigger,
	});
	if (!trigger.ok) {
		input.start.logger.debug(
			"adapter.drop",
			context({
				actor,
				reason: trigger.reason,
			}),
		);
		return;
	}
	const thread = await telegramThreadKey({
		start: input.start,
		provider: input.provider,
		channel,
		actor,
		message: msg,
		response: input.config.response,
	});
	const progress = telegramProgress(input.config.progress);
	const pending = startProgress({
		client: input.client,
		chatId: msg.chat.id,
		threadId: msg.message_thread_id,
		replyTo,
		cancelId: trace,
		progress,
		logger: input.start.logger,
		context: context({ event: input.update.update_id }),
		delivery: input.delivery,
	});
	const stream = telegramReplyStream({
		config: input.config.streaming,
		client: input.client,
		message: msg,
		replyTo,
		logger: input.start.logger,
		context: context(),
		delivery: input.delivery,
		takeoverFirstMessage: () => pending.takeover(),
	});
	await runChatMessage({
		logger: input.start.logger,
		context,
		handler: input.start.handler,
		stream,
		progress: pending,
		loadAttachments: (scope) =>
			telegramAttachments({
				client: input.client,
				store: input.start.attachments,
				scope,
				message: msg,
				provider: input.provider,
				kind: input.kind,
				messageId: String(msg.message_id),
				trace,
				logger: input.start.logger,
			}),
		inbound: () => ({
			trace,
			provider: input.provider,
			kind: input.kind,
			eventId: String(input.update.update_id),
			channel,
			channelName: telegramChatName(msg.chat),
			actor,
			actorBot: Boolean(bot),
			actorName: telegramUserName(msg.from),
			thread,
			threadName: msg.message_thread_id ? `topic ${msg.message_thread_id}` : undefined,
			text,
			data: msg,
		}),
		placement: {
			fresh: async (out) => {
				const ids = await sendTelegramOutput({
					client: input.client,
					store: input.start.attachments,
					message: msg,
					replyTo,
					out,
					skipFirst: false,
					logger: input.start.logger,
					context: context(),
					delivery: input.delivery,
				});
				await indexTelegramProviderMessages({
					start: input.start,
					provider: input.provider,
					channel,
					thread,
					actor: String(input.botId),
					ids,
				});
			},
			streamed: async (out) => {
				const upload = await uploadTelegramAttachments({
					client: input.client,
					store: input.start.attachments,
					chatId: msg.chat.id,
					threadId: msg.message_thread_id,
					replyTo,
					attachments: out.attachments,
					scope: out.attachmentScope,
					logger: input.start.logger,
					context: context(),
					delivery: input.delivery,
				});
				await indexTelegramProviderMessages({
					start: input.start,
					provider: input.provider,
					channel,
					thread,
					actor: String(input.botId),
					ids: [...(stream?.ids?.() ?? []), ...upload.messageIds],
				});
				await postTelegramAttachmentUploadNotice({
					client: input.client,
					chatId: msg.chat.id,
					threadId: msg.message_thread_id,
					replyTo,
					upload,
					context: context(),
					delivery: input.delivery,
				});
			},
			progress: async (out) => {
				const edited = await pending.update(out);
				const ids = await sendTelegramOutput({
					client: input.client,
					store: input.start.attachments,
					message: msg,
					replyTo,
					out,
					skipFirst: edited,
					logger: input.start.logger,
					context: context(),
					delivery: input.delivery,
				});
				await indexTelegramProviderMessages({
					start: input.start,
					provider: input.provider,
					channel,
					thread,
					actor: String(input.botId),
					ids,
				});
			},
		},
		sendError: async () => {
			const text = userError(input.start.messages?.error);
			const edited = await pending.update({ text });
			await sendChunks({
				client: input.client,
				message: msg,
				text,
				skipFirst: edited,
				logger: input.start.logger,
				context: context(),
				delivery: input.delivery,
			});
		},
	});
}

async function handleCallback(input: {
	client: TelegramClient;
	handler: Handler;
	logger: Logger;
	store?: AttachmentStore;
	messages?: AppMessages;
	callback: TelegramCallbackQuery;
	delivery: DeliveryQueue;
	provider: string;
	kind: string;
}): Promise<void> {
	const msg = input.callback.message;
	const action = parseTelegramCallback(input.callback.data);
	if (!msg || !action) {
		await input.client.answerCallbackQuery({ callback_query_id: input.callback.id, text: "Unknown action" });
		return;
	}
	const channel = String(msg.chat.id);
	const actor = String(input.callback.from.id);
	const thread = threadKey(msg);
	const trace = `telegram:${input.callback.id}`;
	const context = (extra?: Record<string, unknown>) =>
		logCtx({ trace, adapter: input.provider, kind: input.kind, channel }, extra);
	let answered = false;
	let acknowledged = false;
	const answer = async () => {
		if (answered) return;
		await input.delivery.run(
			() => input.client.answerCallbackQuery({ callback_query_id: input.callback.id }),
			context(),
		);
		answered = true;
	};
	const acknowledge = async (out: Outbound) => {
		await answer();
		await input.delivery.run(
			() =>
				input.client.editMessageText({
					chat_id: msg.chat.id,
					message_id: msg.message_id,
					text: firstChunk(
						telegramResolvedApprovalText(out, "approved", telegramActor(input.callback.from)),
						false,
					),
					reply_markup: emptyMarkup(),
				}),
			context(),
		);
		acknowledged = true;
	};
	const replace = async (out: Outbound) => {
		await answer();
		await input.delivery.run(
			() =>
				input.client.editMessageText({
					chat_id: msg.chat.id,
					message_id: msg.message_id,
					text: firstChunk(
						telegramResolvedApprovalText(
							out,
							out.approvalResolution ?? (action.kind === "deny" ? "rejected" : "approved"),
							telegramActor(input.callback.from),
							msg.text,
						),
						false,
					),
					reply_markup: emptyMarkup(),
				}),
			context(),
		);
	};
	try {
		const out = await input.handler({
			trace,
			provider: input.provider,
			kind: input.kind,
			eventId: input.callback.id,
			channel,
			actor,
			thread,
			text: actionText(action),
			data: input.callback,
			ack: action.kind === "approve" ? (out) => acknowledge(out) : undefined,
			replace: action.kind === "approve" || action.kind === "deny" ? replace : undefined,
		});
		if (!out) {
			await answer();
			return;
		}
		if (out.silent) {
			await answer();
			return;
		}
		if (out.private) {
			if (out.replaceOriginal) {
				await answer();
				await input.delivery.run(
					() =>
						input.client.editMessageText({
							chat_id: msg.chat.id,
							message_id: msg.message_id,
							text: firstChunk(
								telegramResolvedApprovalText(out, out.approvalResolution, undefined, msg.text),
								false,
							),
							reply_markup: emptyMarkup(),
						}),
					context(),
				);
				return;
			}
			answered = true;
			await input.delivery.run(
				() =>
					input.client.answerCallbackQuery({
						callback_query_id: input.callback.id,
						text: truncate(out.text, TELEGRAM_CALLBACK_LIMIT),
						show_alert: true,
					}),
				context(),
			);
			return;
		}
		await answer();
		if (acknowledged) {
			await sendTelegramOutput({
				client: input.client,
				store: input.store,
				message: msg,
				out,
				logger: input.logger,
				context: context({ thread }),
				delivery: input.delivery,
			});
			return;
		}
		const rendered = {
			...out,
			text: out.text,
		};
		if (action.kind === "deny" && out.approvalResolution) {
			await input.delivery.run(
				() =>
					input.client.editMessageText({
						chat_id: msg.chat.id,
						message_id: msg.message_id,
						text: firstChunk(
							telegramResolvedApprovalText(
								out,
								out.approvalResolution,
								telegramActor(input.callback.from),
								msg.text,
							),
							false,
						),
						reply_markup: emptyMarkup(),
					}),
				context(),
			);
			return;
		}
		if (action.kind === "approve") {
			await sendTelegramOutput({
				client: input.client,
				store: input.store,
				message: msg,
				out,
				logger: input.logger,
				context: context({ thread }),
				delivery: input.delivery,
			});
			return;
		}
		const approval = rendered.approval;
		await input.delivery.run(
			() =>
				input.client.editMessageText({
					chat_id: msg.chat.id,
					message_id: msg.message_id,
					text: firstChunk(telegramApprovalText(rendered.text, approval), Boolean(approval)),
					reply_markup: approval ? approvalMarkup(approval) : undefined,
				}),
			context(),
		);
		await sendTelegramOutput({
			client: input.client,
			store: input.store,
			message: msg,
			out: rendered,
			skipFirst: true,
			logger: input.logger,
			context: context({ thread }),
			delivery: input.delivery,
		});
	} catch (error) {
		input.logger.error(
			"adapter.error",
			context({
				thread,
				error: errorMessage(error),
			}),
		);
		await input.delivery.run(
			() =>
				input.client.answerCallbackQuery({
					callback_query_id: input.callback.id,
					text: userError(input.messages?.error),
					show_alert: true,
				}),
			context(),
		);
	}
}

async function sendTelegramOutput(input: {
	client: TelegramClient;
	store?: AttachmentStore;
	message: TelegramMessage;
	replyTo?: number;
	out: Outbound;
	skipFirst?: boolean;
	logger: Logger;
	context: Record<string, unknown>;
	delivery: DeliveryQueue;
}): Promise<string[]> {
	const ids = await sendChunks({
		client: input.client,
		message: input.message,
		replyTo: input.replyTo,
		text: input.out.text,
		approval: input.out.approval,
		skipFirst: input.skipFirst,
		logger: input.logger,
		context: input.context,
		delivery: input.delivery,
	});
	const upload = await uploadTelegramAttachments({
		client: input.client,
		store: input.store,
		chatId: input.message.chat.id,
		threadId: input.message.message_thread_id,
		replyTo: input.replyTo,
		attachments: input.out.attachments,
		scope: input.out.attachmentScope,
		logger: input.logger,
		context: input.context,
		delivery: input.delivery,
	});
	await postTelegramAttachmentUploadNotice({
		client: input.client,
		chatId: input.message.chat.id,
		threadId: input.message.message_thread_id,
		replyTo: input.replyTo,
		upload,
		context: input.context,
		delivery: input.delivery,
	});
	return [...ids, ...upload.messageIds];
}

async function sendChunks(input: {
	client: TelegramClient;
	message: TelegramMessage;
	replyTo?: number;
	text: string;
	approval?: Outbound["approval"];
	skipFirst?: boolean;
	logger?: Logger;
	context?: Record<string, unknown>;
	delivery: DeliveryQueue;
}): Promise<string[]> {
	const chunks = telegramChunks(telegramApprovalText(input.text, input.approval), Boolean(input.approval));
	const ids: string[] = [];
	for (let index = input.skipFirst ? 1 : 0; index < chunks.length; index++) {
		const sent = await input.delivery.run(
			() =>
				input.client.sendMessage({
					chat_id: input.message.chat.id,
					message_thread_id: input.message.message_thread_id,
					text: chunks[index],
					reply_to_message_id: input.replyTo,
					reply_markup: index === 0 && input.approval ? approvalMarkup(input.approval) : undefined,
				}),
			{ ...input.context, retry: "send" },
		);
		ids.push(String(sent.message_id));
	}
	return ids;
}

async function sendTargetChunks(input: {
	client: TelegramClient;
	chatId: number;
	threadId?: number;
	text: string;
	approval?: Outbound["approval"];
	logger?: Logger;
	context?: Record<string, unknown>;
	delivery: DeliveryQueue;
}): Promise<void> {
	const chunks = telegramChunks(telegramApprovalText(input.text, input.approval), Boolean(input.approval));
	for (let index = 0; index < chunks.length; index++) {
		await input.delivery.run(
			() =>
				input.client.sendMessage({
					chat_id: input.chatId,
					message_thread_id: input.threadId,
					text: chunks[index],
					reply_markup: index === 0 && input.approval ? approvalMarkup(input.approval) : undefined,
				}),
			{ ...input.context, retry: "send" },
		);
	}
}

function telegramReplyStream(input: {
	config?: ReplyStreamOption;
	client: TelegramClient;
	message: TelegramMessage;
	replyTo?: number;
	logger: Logger;
	context: Record<string, unknown>;
	delivery: DeliveryQueue;
	takeoverFirstMessage?: () => Promise<string | undefined>;
}) {
	if (!input.config || (typeof input.config === "object" && input.config.enabled === false)) return undefined;
	return new DraftReplyStream(
		{
			limit: TELEGRAM_TEXT_LIMIT,
			create: async (text) => {
				const adopted = await input.takeoverFirstMessage?.();
				if (adopted) {
					await input.delivery.run(
						() =>
							input.client.editMessageText({
								chat_id: input.message.chat.id,
								message_id: Number(adopted),
								text,
								reply_markup: emptyMarkup(),
							}),
						input.context,
					);
					return adopted;
				}
				const res = await input.delivery.run(
					() =>
						input.client.sendMessage({
							chat_id: input.message.chat.id,
							message_thread_id: input.message.message_thread_id,
							text,
							reply_to_message_id: input.replyTo,
						}),
					{ ...input.context, retry: "send" },
				);
				return String(res.message_id);
			},
			edit: async (id, text) => {
				await input.delivery.run(
					() =>
						input.client.editMessageText({
							chat_id: input.message.chat.id,
							message_id: Number(id),
							text,
							reply_markup: emptyMarkup(),
						}),
					input.context,
				);
			},
			delete: async (id) => {
				await input.delivery.run(
					() => input.client.deleteMessage({ chat_id: input.message.chat.id, message_id: Number(id) }),
					input.context,
				);
			},
		},
		input.config,
		input.logger,
		input.context,
	);
}

function telegramProgress(input: TelegramConfig["progress"]): TelegramProgress | undefined {
	if (input === false) return undefined;
	return input ?? { delayMs: 0 };
}

type TelegramAttachmentUploadResult = {
	requested: number;
	resolved: number;
	uploaded: boolean;
	messageIds: string[];
};

async function uploadTelegramAttachments(input: {
	client: TelegramClient;
	store?: AttachmentStore;
	chatId: number;
	threadId?: number;
	replyTo?: number;
	attachments?: Array<{ path: string; name?: string; mimeType?: string }>;
	scope?: ScopedKey;
	logger: Logger;
	context: Record<string, unknown>;
	delivery: DeliveryQueue;
}): Promise<TelegramAttachmentUploadResult> {
	const requested = input.attachments?.length ?? 0;
	if (!requested) return { requested, resolved: 0, uploaded: true, messageIds: [] };
	const files = await resolveOutboundAttachments({
		provider: "telegram",
		store: input.store,
		attachments: input.attachments,
		scope: input.scope,
		logger: input.logger,
		context: input.context,
	});
	if (!files.length) return { requested, resolved: 0, uploaded: false, messageIds: [] };
	let uploaded = true;
	const messageIds: string[] = [];
	for (const file of files) {
		try {
			const sent = await input.delivery.run(
				() =>
					input.client.sendDocument({
						chat_id: input.chatId,
						message_thread_id: input.threadId,
						reply_to_message_id: input.replyTo,
						document: file,
					}),
				{ ...input.context, retry: "send" },
			);
			messageIds.push(String(sent.message_id));
		} catch (error) {
			uploaded = false;
			input.logger.warn("telegram.attachment_upload_failed", { ...input.context, error: errorMessage(error) });
		}
	}
	return { requested, resolved: files.length, uploaded, messageIds };
}

async function postTelegramAttachmentUploadNotice(input: {
	client: TelegramClient;
	chatId: number;
	threadId?: number;
	replyTo?: number;
	upload: TelegramAttachmentUploadResult;
	context: Record<string, unknown>;
	delivery: DeliveryQueue;
}): Promise<void> {
	if (!input.upload.requested) return;
	if (input.upload.uploaded && input.upload.resolved === input.upload.requested) return;
	const text =
		input.upload.resolved > 0
			? "I created the file, but Telegram did not accept the upload. Check the bot's file permissions and server logs."
			: "I created the file, but heypi could not resolve it for upload. Check server logs for the attachment path error.";
	await input.delivery.run(
		() =>
			input.client.sendMessage({
				chat_id: input.chatId,
				message_thread_id: input.threadId,
				reply_to_message_id: input.replyTo,
				text,
			}),
		{ ...input.context, retry: "send" },
	);
}

async function indexTelegramProviderMessages(input: {
	start: AdapterStart;
	provider: string;
	channel: string;
	thread: string;
	actor?: string;
	ids: string[];
}): Promise<void> {
	const agent = input.start.app?.agent;
	const store = input.start.store;
	if (!agent || !store?.providerMessages || input.ids.length === 0) return;
	const row = await store.threads.getByKey(agent, input.provider, undefined, input.thread);
	if (!row) return;
	for (const id of input.ids) {
		await store.providerMessages.upsert({
			agent,
			provider: input.provider,
			channel: input.channel,
			providerMessageId: id,
			threadId: row.id,
			actor: input.actor,
		});
	}
}

export function startProgress(input: {
	client: TelegramClient;
	chatId: number;
	threadId?: number;
	replyTo?: number;
	cancelId: string;
	progress?: TelegramProgress;
	logger: Logger;
	context: Record<string, unknown>;
	delivery: DeliveryQueue;
}) {
	let active = true;
	let placeholder: number | undefined;
	let task: Promise<void> | undefined;
	let timer: ReturnType<typeof setTimeout> | undefined;
	let resolveTask: (() => void) | undefined;
	let message = input.progress ? (input.progress.message ?? "Working...") : false;
	const finishTask = () => {
		const resolve = resolveTask;
		resolveTask = undefined;
		task = undefined;
		resolve?.();
	};
	const cancelTimer = () => {
		if (!timer) return;
		clearTimeout(timer);
		timer = undefined;
		finishTask();
	};
	if (message) {
		task = new Promise((resolve) => {
			resolveTask = resolve;
			timer = setTimeout(() => {
				timer = undefined;
				if (!active) {
					finishTask();
					return;
				}
				const progressText = message;
				if (progressText === false) {
					finishTask();
					return;
				}
				input.delivery
					.run(
						() =>
							input.client.sendMessage({
								chat_id: input.chatId,
								message_thread_id: input.threadId,
								reply_to_message_id: input.replyTo,
								text: progressText,
								reply_markup: progressMarkup(input.cancelId),
							}),
						{ ...input.context, delivery: "progress", retry: "send" },
					)
					.then((out) => {
						placeholder = out.message_id;
					})
					.catch((error) => {
						input.logger.warn("telegram.progress.message_failed", {
							...input.context,
							error: errorMessage(error),
						});
					})
					.finally(finishTask);
			}, input.progress?.delayMs ?? 750);
		});
	}
	return {
		async notify(text: string): Promise<void> {
			if (message === false) return;
			message = text;
			if (!placeholder) return;
			await input.delivery
				.run(
					() =>
						input.client.editMessageText({
							chat_id: input.chatId,
							message_id: placeholder as number,
							text,
							reply_markup: progressMarkup(input.cancelId),
						}),
					{ ...input.context, delivery: "progress_notify" },
				)
				.catch((error) => {
					input.logger.warn("telegram.progress.notify_failed", {
						...input.context,
						error: errorMessage(error),
					});
				});
		},
		async update(out: Outbound): Promise<boolean> {
			active = false;
			cancelTimer();
			await task;
			if (!placeholder) return false;
			const messageId = placeholder;
			placeholder = undefined;
			try {
				await input.delivery.run(
					() =>
						input.client.editMessageText({
							chat_id: input.chatId,
							message_id: messageId,
							text: firstChunk(telegramApprovalText(out.text, out.approval), Boolean(out.approval)),
							reply_markup: out.approval ? approvalMarkup(out.approval) : undefined,
						}),
					{ ...input.context, delivery: "progress_update" },
				);
				return true;
			} catch (error) {
				input.logger.warn("telegram.progress.update_failed", { ...input.context, error: errorMessage(error) });
				return false;
			}
		},
		async takeover(): Promise<string | undefined> {
			active = false;
			cancelTimer();
			await task;
			const messageId = placeholder;
			placeholder = undefined;
			return messageId === undefined ? undefined : String(messageId);
		},
		async stop(): Promise<void> {
			active = false;
			cancelTimer();
			await task;
			if (!placeholder) return;
			const messageId = placeholder;
			placeholder = undefined;
			await input.delivery
				.run(() => input.client.deleteMessage({ chat_id: input.chatId, message_id: messageId }), {
					...input.context,
					delivery: "progress_delete",
				})
				.catch((error) => {
					input.logger.warn("telegram.progress.delete_failed", { ...input.context, error: errorMessage(error) });
				});
		},
	};
}

async function telegramAttachments(input: {
	client: TelegramClient;
	store?: AttachmentStore;
	scope?: ScopedKey;
	message: TelegramMessage;
	provider: string;
	kind: string;
	messageId: string;
	trace: string;
	logger: Logger;
}): Promise<Attachment[] | undefined> {
	const files = filesOf(input.message);
	const maxBytes = input.store?.maxBytes;
	return await saveInboundAttachments({
		provider: input.provider,
		kind: input.kind,
		store: input.store,
		scope: input.scope,
		messageId: input.messageId,
		trace: input.trace,
		logItemField: "file",
		logger: input.logger,
		refs: files,
		download: async (file) => {
			const found = await input.client.getFile({ file_id: file.id });
			return await input.client.downloadFile(found.file_path, maxBytes);
		},
	});
}

function textOf(msg: TelegramMessage): string {
	return msg.text ?? msg.caption ?? "";
}

function threadKey(msg: TelegramMessage): string {
	return `${msg.chat.id}:${msg.message_thread_id ?? msg.chat.id}`;
}

async function telegramThreadKey(input: {
	start: AdapterStart;
	provider: string;
	channel: string;
	actor: string;
	message: TelegramMessage;
	response?: TelegramResponseConfig;
}): Promise<string> {
	if (telegramDm(input.message) || input.message.message_thread_id !== undefined) return threadKey(input.message);
	const agent = input.start.app?.agent;
	const store = input.start.store;
	if (!agent || !store) return threadKey(input.message);
	const replyMessageId = input.message.reply_to_message?.message_id;
	if (replyMessageId !== undefined && store.providerMessages) {
		const found = await store.providerMessages.get({
			agent,
			provider: input.provider,
			channel: input.channel,
			providerMessageId: String(replyMessageId),
		});
		if (found) return (await store.threads.get(found.threadId))?.key ?? found.threadId;
	}
	const continueRecentMs = input.response?.continueRecentMs ?? 300_000;
	if (continueRecentMs !== false && store.threads.getRecentForActor) {
		const recent = await store.threads.getRecentForActor({
			agent,
			provider: input.provider,
			channel: input.channel,
			actor: input.actor,
			since: Date.now() - continueRecentMs,
		});
		if (recent && !(await store.locks?.get(`thread:${recent.id}`))) return recent.key;
	}
	return `${input.channel}:${input.message.message_id}`;
}

function telegramReplyTo(response: TelegramResponseConfig | undefined, msg: TelegramMessage): number | undefined {
	if (response?.placement === "reply") return msg.message_id;
	if (response?.placement === "same") return undefined;
	if (telegramDm(msg) || msg.message_thread_id !== undefined) return undefined;
	return msg.message_id;
}

function telegramDm(msg: TelegramMessage): boolean {
	return msg.chat.type === "private";
}

export function telegramAllowed(
	allow: TelegramAllow | undefined,
	event: { chat: string; user: string; bot?: string; botSelf?: number | string; isDm: boolean },
): { ok: true } | { ok: false; reason: string } {
	return allowByDimensions({
		dms: allow?.dms,
		isDm: event.isDm,
		dmReason: "dm_not_allowed",
		dimensions: [
			{ allowlist: allow?.chats?.map(String), value: event.chat, reason: "chat_not_allowed", skip: event.isDm },
			{
				allowlist: telegramActorAllowlist(allow),
				value: telegramActorValue(allow, event),
				reason: "user_not_allowed",
			},
		],
	});
}

function telegramActorAllowlist(allow: TelegramAllow | undefined): string[] | undefined {
	if (!allow?.users?.length && !botsConfigured(allow?.bots)) return undefined;
	return ["allowed"];
}

function telegramActorValue(
	allow: TelegramAllow | undefined,
	event: { user: string; bot?: string; botSelf?: number | string },
): string | undefined {
	if (event.bot) return telegramBotAllowed(allow?.bots, event.bot, event.botSelf) ? "allowed" : undefined;
	if (!allow?.users?.length) return "allowed";
	if (allow.users.map(String).includes(event.user)) return "allowed";
	return undefined;
}

export function telegramBotAllowed(
	allow: TelegramAllow["bots"] | undefined,
	bot: string | number,
	self: string | number | undefined,
): boolean {
	if (self === undefined) return false;
	const id = String(bot);
	if (id === String(self)) return false;
	if (allow === true) return true;
	if (!Array.isArray(allow) || allow.length === 0) return false;
	return allow.map(String).includes(id);
}

function botsConfigured(bots: TelegramAllow["bots"] | undefined): boolean {
	return bots === true || (Array.isArray(bots) && bots.length > 0);
}

export function telegramTriggered(
	trigger: TelegramTrigger | undefined,
	event: {
		text?: string;
		isDm: boolean;
		botUsername?: string;
		thread?: boolean;
		threadTrigger?: TelegramTrigger | false;
	},
): { ok: true } | { ok: false; reason: string } {
	return messageTriggered({
		trigger,
		isDm: event.isDm,
		thread: event.thread,
		threadTrigger: event.threadTrigger,
		mentioned: Boolean(event.botUsername && telegramMentions(event.text, event.botUsername)),
		text: event.text,
		reason: "mention_required",
	});
}

function telegramMentions(text = "", username: string): boolean {
	const escaped = username.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
	return new RegExp(`(^|\\s)@${escaped}\\b`, "i").test(text);
}

function stripTelegramMention(text: string, username?: string): string {
	if (!username) return text;
	const escaped = username.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
	return text.replace(new RegExp(`(^|\\s)@${escaped}\\b`, "gi"), "$1").trim();
}

function actionText(action: TelegramAction): string {
	if (action.kind === STATUS) return "/status";
	return `/${action.kind} ${action.id}`;
}

function telegramResolvedApprovalText(
	out: Outbound,
	state: Outbound["approvalResolution"],
	actor?: string,
	original?: string,
): string {
	if (out.approval && state) return telegramApprovalText(out.text, out.approval, state, actor);
	if (original) return [original, out.text].filter(Boolean).join("\n\n");
	return out.text;
}

function telegramActor(user: TelegramUser): string {
	return user.username ? `@${user.username}` : `user ${user.id}`;
}

export function telegramChunks(text: string, hasMarkup = false): string[] {
	return chunkText(text, hasMarkup ? 3800 : TELEGRAM_TEXT_LIMIT);
}

function firstChunk(text: string, hasMarkup: boolean): string {
	return telegramChunks(text, hasMarkup)[0] ?? "";
}

export function telegramApprovalText(
	text: string,
	approval?: Outbound["approval"],
	state?: Outbound["approvalResolution"],
	actor?: string,
): string {
	if (!approval) return text;
	return [
		approvalTitleText(state),
		approval.reason ? ["Reason:", approval.reason].join("\n") : undefined,
		...(approval.details ?? []).map((detail) =>
			[`${detail.label}:`, detail.format === "code" ? codeFence(detail.value) : detail.value].join("\n"),
		),
		`Approval ID: ${approval.id}`,
		approval.requestedBy ? `Requested by: ${approval.requestedBy}` : undefined,
		state ? approvalResolutionText(state, actor) : undefined,
	]
		.filter((line): line is string => typeof line === "string")
		.join("\n\n");
}

function approvalResolutionText(state: NonNullable<Outbound["approvalResolution"]>, actor?: string): string {
	return approvalStateLine(state, actor);
}

function approvalTitleText(state?: Outbound["approvalResolution"]): string {
	return `*${approvalStateTitle(state)}*`;
}

function progressMarkup(id: string): TelegramReplyMarkup {
	return {
		inline_keyboard: [
			[
				{ text: "Cancel", callback_data: `${CANCEL}:${id}` },
				{ text: "Status", callback_data: STATUS },
			],
		],
	};
}

function approvalMarkup(approval: NonNullable<Outbound["approval"]>): TelegramReplyMarkup {
	return {
		inline_keyboard: [
			[
				{ text: "Approve", callback_data: `${APPROVE}:${approval.id}` },
				{ text: "Reject", callback_data: `${DENY}:${approval.id}` },
			],
		],
	};
}

function emptyMarkup(): TelegramReplyMarkup {
	return { inline_keyboard: [] };
}

type TelegramAction =
	| { kind: "approve"; id: string }
	| { kind: "deny"; id: string }
	| { kind: "cancel"; id: string }
	| { kind: "status" };

export function parseTelegramCallback(input?: string): TelegramAction | undefined {
	if (!input) return undefined;
	if (input === STATUS) return { kind: STATUS };
	const index = input.indexOf(":");
	if (index <= 0) return undefined;
	const kind = input.slice(0, index);
	const id = input.slice(index + 1);
	if (!id) return undefined;
	if (kind === APPROVE || kind === DENY || kind === CANCEL) return { kind, id };
	return undefined;
}

function filesOf(msg: TelegramMessage): Array<{ id: string; name: string; mimeType?: string; size?: number }> {
	const out: Array<{ id: string; name: string; mimeType?: string; size?: number }> = [];
	if (msg.document) {
		out.push({
			id: msg.document.file_id,
			name: msg.document.file_name ?? `${msg.document.file_id}.bin`,
			mimeType: msg.document.mime_type,
			size: msg.document.file_size,
		});
	}
	if (msg.photo?.length) {
		const photo = [...msg.photo].sort((a, b) => (b.file_size ?? 0) - (a.file_size ?? 0))[0];
		if (photo)
			out.push({
				id: photo.file_id,
				name: `${photo.file_unique_id ?? photo.file_id}.jpg`,
				mimeType: "image/jpeg",
				size: photo.file_size,
			});
	}
	return out;
}

function truncate(text: string, limit: number): string {
	return text.length <= limit ? text : `${text.slice(0, Math.max(0, limit - 1))}…`;
}

function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

class TelegramClient {
	private readonly base: string;

	constructor(
		private readonly token: string,
		apiUrl?: TelegramConfig["apiUrl"],
	) {
		this.base = `${telegramApiUrl(apiUrl).replace(/\/+$/, "")}/bot${token}`;
	}

	async getUpdates(input: { offset: number; timeout: number }): Promise<TelegramUpdate[]> {
		const out = await this.call<{ result: TelegramUpdate[] }>("getUpdates", input);
		return out.result;
	}

	async getMe(): Promise<TelegramUser> {
		const out = await this.call<{ result: TelegramUser }>("getMe", {});
		return out.result;
	}

	async setMyCommands(input: { commands: TelegramBotCommand[] }): Promise<void> {
		await this.call("setMyCommands", input);
	}

	async sendMessage(input: TelegramSendMessage): Promise<TelegramMessage> {
		const out = await this.call<{ result: TelegramMessage }>("sendMessage", compact(input));
		return out.result;
	}

	async editMessageText(input: TelegramEditMessageText): Promise<void> {
		await this.call("editMessageText", compact(input));
	}

	async deleteMessage(input: { chat_id: number; message_id: number }): Promise<void> {
		await this.call("deleteMessage", input);
	}

	async answerCallbackQuery(input: TelegramAnswerCallbackQuery): Promise<void> {
		await this.call("answerCallbackQuery", compact(input));
	}

	async getFile(input: { file_id: string }): Promise<{ file_path: string }> {
		const out = await this.call<{ result: { file_path: string } }>("getFile", input);
		return out.result;
	}

	async downloadFile(path: string, maxBytes?: number): Promise<Uint8Array> {
		const url = `${this.baseFile}/${path}`;
		const response = await fetch(url);
		if (!response.ok) throw new Error(`Telegram file download failed: ${response.status}`);
		return await responseBytes(response, maxBytes);
	}

	async sendDocument(input: {
		chat_id: number;
		message_thread_id?: number;
		reply_to_message_id?: number;
		document: ResolvedAttachment;
	}): Promise<TelegramMessage> {
		const form = new FormData();
		const data = await readFile(input.document.path);
		form.set("chat_id", String(input.chat_id));
		if (input.message_thread_id !== undefined) form.set("message_thread_id", String(input.message_thread_id));
		if (input.reply_to_message_id !== undefined) form.set("reply_to_message_id", String(input.reply_to_message_id));
		form.set("document", new Blob([data], { type: input.document.mimeType }), input.document.name);
		const out = await this.callForm<{ result: TelegramMessage }>("sendDocument", form);
		return out.result;
	}

	private get baseFile(): string {
		const root = this.base.slice(0, this.base.indexOf(`/bot${this.token}`));
		return `${root}/file/bot${this.token}`;
	}

	private async call<T = unknown>(method: string, body: unknown): Promise<T> {
		const response = await fetch(`${this.base}/${method}`, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify(body),
		});
		const parsed = (await response.json()) as TelegramResponse<T>;
		if (!response.ok || !parsed.ok) throw telegramError(parsed, response.status);
		return parsed as T;
	}

	private async callForm<T = unknown>(method: string, body: FormData): Promise<T> {
		const response = await fetch(`${this.base}/${method}`, { method: "POST", body });
		const parsed = (await response.json()) as TelegramResponse<T>;
		if (!response.ok || !parsed.ok) throw telegramError(parsed, response.status);
		return parsed as T;
	}
}

function telegramApiUrl(input?: TelegramConfig["apiUrl"]): string {
	if (input === undefined) return "https://api.telegram.org";
	if (typeof input === "object" && typeof input.override === "string") return input.override;
	throw new Error("Telegram apiUrl override must be explicit: { override: url }");
}

function telegramError(input: TelegramResponse<unknown>, status: number): Error {
	const error = new Error(input.description ?? `Telegram API failed: ${status}`) as Error & { retryAfter?: number };
	error.retryAfter = input.parameters?.retry_after;
	return error;
}

function compact<T extends Record<string, unknown>>(input: T): T {
	const out: Record<string, unknown> = {};
	for (const [key, value] of Object.entries(input)) if (value !== undefined) out[key] = value;
	return out as T;
}

type TelegramResponse<T> = T & { ok?: boolean; description?: string; parameters?: { retry_after?: number } };

type TelegramUpdate = {
	update_id: number;
	message?: TelegramMessage;
	callback_query?: TelegramCallbackQuery;
};

type TelegramCallbackQuery = {
	id: string;
	from: TelegramUser;
	data?: string;
	message?: TelegramMessage;
};

type TelegramUser = {
	id: number;
	is_bot?: boolean;
	username?: string;
	first_name?: string;
};

type TelegramBotCommand = {
	command: string;
	description: string;
};

type TelegramMessage = {
	message_id: number;
	message_thread_id?: number;
	reply_to_message?: { message_id: number };
	from?: TelegramUser;
	chat: { id: number; type?: string; title?: string; username?: string; first_name?: string };
	text?: string;
	caption?: string;
	document?: {
		file_id: string;
		file_name?: string;
		mime_type?: string;
		file_size?: number;
	};
	photo?: Array<{
		file_id: string;
		file_unique_id?: string;
		file_size?: number;
	}>;
};

function telegramUserName(user: TelegramUser | undefined): string | undefined {
	if (!user) return undefined;
	return user.username ? `@${user.username}` : user.first_name;
}

function telegramChatName(chat: TelegramMessage["chat"]): string | undefined {
	return chat.title ?? (chat.username ? `@${chat.username}` : chat.first_name);
}

const noopLogger: Logger = {
	debug: () => undefined,
	info: () => undefined,
	warn: () => undefined,
	error: () => undefined,
};

type TelegramReplyMarkup = {
	inline_keyboard: Array<Array<{ text: string; callback_data: string }>>;
};

type TelegramSendMessage = {
	chat_id: number;
	message_thread_id?: number;
	reply_to_message_id?: number;
	text: string;
	reply_markup?: TelegramReplyMarkup;
};

type TelegramEditMessageText = {
	chat_id: number;
	message_id: number;
	text: string;
	reply_markup?: TelegramReplyMarkup;
};

type TelegramAnswerCallbackQuery = {
	callback_query_id: string;
	text?: string;
	show_alert?: boolean;
};
