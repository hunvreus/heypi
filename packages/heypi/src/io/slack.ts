import { type AllMiddlewareArgs, App, HTTPReceiver, type types } from "@slack/bolt";
import type { PermissionsConfig } from "../config.js";
import { approvalStateLine, approvalViewRows, approvalViewTitle, codeFence } from "../core/approval-view.js";
import { actorGroups as configuredGroups } from "../core/approvers.js";
import { commandText } from "../core/commands.js";
import { message as errorMessage, type Logger, userError } from "../core/log.js";
import type { AppMessages } from "../core/messages.js";
import type { ScopedKey } from "../core/scope.js";
import { chunkText } from "../render/chunk.js";
import { actorAllowedValue, actorAllowlist } from "./actor-allow.js";
import { resolveOutboundAttachments, saveInboundAttachments } from "./attachment-policy.js";
import { type Attachment, type AttachmentStore, responseBytes } from "./attachments.js";
import { botAllowConfigured, botIdentityAllowed } from "./bot-allow.js";
import { runChatMessage } from "./chat-message.js";
import { chatAdapterConfigKeys, validateAdapterConfig, warnAdapterConfig } from "./config-validation.js";
import { controlActionLabel } from "./control-action.js";
import { type DeliveryConfig, DeliveryQueue } from "./delivery.js";
import { optionalEnv, requiredEnv } from "./env.js";
import { allowByDimensions, messageTriggered } from "./gate.js";
import type { Adapter, AdapterStart, AdapterTarget, Handler, Outbound } from "./handler.js";
import { logCtx } from "./log-context.js";
import { assertRouteName } from "./name.js";
import { normalizeProgressConfig } from "./progress-config.js";
import { DraftReplyStream, type ReplyStreamOption } from "./reply-stream.js";
import { warnMissingChatAllow } from "./security-warning.js";

const APPROVE = "heypi_approve";
const DENY = "heypi_deny";
const CANCEL = "heypi_cancel";
const STATUS = "heypi_status";
const SLACK_TEXT_LIMIT = 4000;
const SLACK_BLOCK_TEXT_LIMIT = 3000;
const APPROVAL_PENDING_COLOR = "#f2c744";
const APPROVAL_APPROVED_COLOR = "#2eb67d";
const APPROVAL_REJECTED_COLOR = "#e01e5a";
const APPROVAL_EXPIRED_COLOR = "#868686";
const SLACK_CONFIG_KEYS = chatAdapterConfigKeys(
	"botToken",
	"command",
	"mode",
	"appToken",
	"signingSecret",
	"port",
	"path",
	"unsafePathOverride",
);

export type SlackConfig = {
	name?: string;
	botToken?: string;
	command?: string;
	allow?: SlackAllow;
	permissions?: PermissionsConfig;
	trigger?: SlackTrigger;
	threadTrigger?: SlackTrigger | false;
	response?: SlackResponse;
	progress?: SlackProgress | false;
	streaming?: ReplyStreamOption;
	delivery?: DeliveryConfig | false;
} & (SlackSocketConfig | SlackHttpConfig);

export type SlackSocketConfig = {
	mode?: "socket";
	appToken?: string;
	signingSecret?: string;
};

export type SlackHttpConfig = {
	mode: "http";
	signingSecret?: string;
	port?: number | string;
	path?: string | string[];
	unsafePathOverride?: boolean;
};

export type SlackReply = "thread" | "same" | "channel";
export type SlackResponse = {
	placement?: "auto" | SlackReply;
	broadcast?: boolean;
};
export type SlackTrigger = "mention" | "message";

export type SlackAllow = {
	channels?: string[];
	users?: string[];
	groups?: string[];
	bots?: true | string[];
	dms?: boolean;
};

export type SlackProgress = {
	reaction?: string | false;
	message?: string | false;
	delayMs?: number;
};

type ResolvedSlackConfig = SlackConfig & { botToken: string; appToken?: string; signingSecret?: string };

/** Creates the Slack adapter using Socket Mode or Slack's HTTP receiver. */
export function slack(config: SlackConfig = {}): Adapter {
	const input = resolveSlackConfig(config);
	const name = input.name ?? "slack";
	assertRouteName(name);
	const configValidation = validateAdapterConfig(name, input, SLACK_CONFIG_KEYS);
	const setup = slackSetup(input, name);
	const kind = "slack";
	let app: App | undefined;
	let activeLogger: Logger | undefined;
	let delivery = new DeliveryQueue(input.delivery);
	let botUserId: string | undefined;
	let botIdentity: SlackBotIdentity = {};
	const commandName = slackCommandName(input.command);

	return {
		name,
		kind,
		permissions: input.permissions,
		acceptsBots: botAllowConfigured(input.allow?.bots),
		async start(start: AdapterStart): Promise<void> {
			const { handler, logger: log } = start;
			activeLogger = log;
			delivery = new DeliveryQueue(input.delivery, log);
			warnAdapterConfig(log, name, configValidation);
			log.info("adapter.start", { adapter: name, kind, mode: setup.mode });
			if (!slackAllowConfigured(input.allow)) {
				warnMissingChatAllow({ logger: log, adapter: name, kind, surface: "channel" });
			}
			const receiver = setup.mode === "http" ? createSlackReceiver(input, setup, start) : undefined;
			const bolt = createSlackApp(input, setup, receiver);
			const groups = new SlackGroupResolver(
				[
					...(input.allow?.groups ?? []),
					...configuredGroups(start.approval?.approvers),
					...configuredGroups(start.approval?.admins),
				],
				log,
			);
			app = bolt;
			botIdentity = await slackBotIdentity(bolt.client, log);
			botUserId = botIdentity.userId;
			bolt.action(APPROVE, async ({ ack, body, action, client }) => {
				await ack();
				await handleAction({
					kind: "approve",
					body,
					action,
					client,
					handler,
					logger: log,
					delivery,
					provider: name,
					adapterKind: kind,
					groups,
					progress: input.progress,
					streaming: input.streaming,
					messages: start.messages,
					attachments: start.attachments,
				});
			});
			bolt.action(DENY, async ({ ack, body, action, client }) => {
				await ack();
				await handleAction({
					kind: "deny",
					body,
					action,
					client,
					handler,
					logger: log,
					delivery,
					provider: name,
					adapterKind: kind,
					groups,
					messages: start.messages,
					attachments: start.attachments,
				});
			});
			bolt.action(CANCEL, async ({ ack, body, action, client }) => {
				await ack();
				await handleAction({
					kind: "cancel",
					body,
					action,
					client,
					handler,
					logger: log,
					delivery,
					provider: name,
					adapterKind: kind,
					groups,
					messages: start.messages,
					attachments: start.attachments,
				});
			});
			bolt.action(STATUS, async ({ ack, body, action, client }) => {
				await ack();
				await handleAction({
					kind: "status",
					body,
					action,
					client,
					handler,
					logger: log,
					delivery,
					provider: name,
					adapterKind: kind,
					groups,
					messages: start.messages,
					attachments: start.attachments,
				});
			});
			bolt.command(commandName, async ({ ack, command, client }) => {
				await ack();
				await handleCommand({
					command,
					client,
					handler,
					logger: log,
					delivery,
					provider: name,
					adapterKind: kind,
					commandName,
					groups,
					allow: input.allow,
					messages: start.messages,
					attachments: start.attachments,
				});
			});
			bolt.message(async ({ event, client, body }) => {
				const msg = event as {
					subtype?: string;
					bot_id?: string;
					type?: string;
					team?: string;
					channel?: string;
					channel_type?: string;
					user?: string;
					app_id?: string;
					text?: string;
					client_msg_id?: string;
					ts?: string;
					thread_ts?: string;
					files?: SlackFile[];
				};
				const bot = slackBotSender(msg, botIdentity);
				const channel = msg.channel ?? "unknown";
				const team = slackTeam(body) ?? msg.team;
				const mode = slackPlacement(input.response);
				const reply = target(mode, msg);
				const trace = msg.client_msg_id ?? msg.ts;
				const context = (extra?: Record<string, unknown>) => logCtx({ trace, adapter: name, kind, channel }, extra);
				if (!slackMessageSubtypeAllowed(msg.subtype, Boolean(bot))) {
					log.debug(
						"adapter.drop",
						context({ actor: msg.user, reason: "subtype_not_allowed", subtype: msg.subtype }),
					);
					return;
				}
				if (bot && !slackBotAllowed(input.allow?.bots, bot, botIdentity)) {
					log.debug(
						"adapter.drop",
						context({ actor: msg.user ?? bot.botId ?? bot.appId, reason: "bot_not_allowed" }),
					);
					return;
				}
				const actor = slackActor(msg, bot);
				const actorGroups = bot ? [] : await groups.forUser(client, msg.user);
				const allow = slackAllowed(input.allow, {
					channel,
					user: msg.user,
					groups: actorGroups,
					bot,
					botSelf: botIdentity,
					isDm: slackDm(msg),
				});
				if (!allow.ok) {
					log.debug(
						"adapter.drop",
						context({
							actor: msg.user,
							reason: allow.reason,
						}),
					);
					return;
				}
				const trigger = slackTriggered(input.trigger, {
					text: msg.text,
					type: msg.type,
					isDm: slackDm(msg),
					botUserId,
					thread: Boolean(msg.thread_ts),
					threadTrigger: input.threadTrigger,
				});
				if (!trigger.ok) {
					log.debug(
						"adapter.drop",
						context({
							actor: msg.user,
							reason: trigger.reason,
						}),
					);
					return;
				}
				log.debug(
					"adapter.receive",
					context({
						thread: msg.thread_ts,
						actor,
						actorGroups,
						event: msg.client_msg_id ?? msg.ts,
					}),
				);
				const progress = slackProgress(input.progress);
				const pending = startProgress({
					channel,
					source: shouldReact(mode, msg) ? msg.ts : undefined,
					target: reply.thread,
					client,
					progress,
					cancelId: trace,
					logger: log,
					context: context({ thread: msg.thread_ts ?? reply.thread, event: msg.ts }),
					delivery,
				});
				const stream = slackReplyStream({
					config: input.streaming,
					client,
					channel,
					thread: reply.thread,
					approval: undefined,
					logger: log,
					context: context({ thread: reply.thread }),
					delivery,
					takeoverFirstMessage: () => pending.takeover(),
				});
				await runChatMessage({
					logger: log,
					context: (extra) => context({ thread: reply.thread, ...extra }),
					handler,
					stream,
					progress: pending,
					loadAttachments: (scope) =>
						slackAttachments({
							store: start.attachments,
							scope,
							files: msg.files,
							token: input.botToken,
							provider: name,
							kind,
							messageId: msg.ts,
							trace,
							logger: log,
						}),
					inbound: () => ({
						trace,
						provider: name,
						kind,
						eventId: msg.client_msg_id ?? msg.ts,
						providerMessageId: msg.ts,
						team,
						channel,
						actor,
						actorGroups,
						actorBot: Boolean(bot),
						thread: threadKey(mode, msg),
						text: msg.text ?? "",
						data: { channel: msg.channel, ts: msg.ts, thread_ts: msg.thread_ts, files: msg.files },
					}),
					sendPrivate: async (out) => {
						await postEphemeralChunks({
							client,
							channel,
							user: msg.user ?? "unknown",
							text: out.text,
							approval: out.approval,
							thread: reply.thread,
							delivery,
						});
						if (out.attachments?.length) {
							await postEphemeralChunks({
								client,
								channel,
								user: msg.user ?? "unknown",
								text: "File attachments cannot be sent privately on Slack.",
								thread: reply.thread,
								delivery,
							});
						}
					},
					placement: {
						fresh: async (out) => {
							await postPublicChunks({
								client,
								channel,
								text: out.text,
								approval: out.approval,
								thread: reply.thread,
								replyBroadcast: input.response?.broadcast ?? false,
								skipFirst: false,
								logger: log,
								context: context({ thread: reply.thread }),
								delivery,
							});
						},
						streamed: async () => undefined,
						progress: async (out) => {
							const sent = await pending.update(out.text, out.approval);
							await postPublicChunks({
								client,
								channel,
								text: out.text,
								approval: sent ? undefined : out.approval,
								thread: reply.thread,
								replyBroadcast: input.response?.broadcast ?? false,
								skipFirst: sent,
								logger: log,
								context: context({ thread: reply.thread }),
								delivery,
							});
						},
					},
					sendError: async () => {
						const text = userError(start.messages?.error);
						const sent = await pending.update(text);
						await postPublicChunks({
							client,
							channel,
							text,
							thread: reply.thread,
							replyBroadcast: input.response?.broadcast ?? false,
							skipFirst: sent,
							logger: log,
							context: context({ thread: reply.thread }),
							delivery,
						});
					},
					afterSend: async (out, visibility) => {
						if (visibility === "public") {
							const upload = await uploadSlackAttachments({
								client,
								store: start.attachments,
								channel,
								thread: reply.thread,
								attachments: out.attachments,
								scope: out.attachmentScope,
								logger: log,
								context: context({ thread: reply.thread }),
								delivery,
							});
							await postSlackAttachmentUploadNotice({
								client,
								channel,
								thread: reply.thread,
								upload,
								logger: log,
								context: context({ thread: reply.thread }),
								delivery,
							});
						}
						const fields =
							visibility === "public"
								? { thread: reply.thread, chars: out.text.length }
								: { private: true, chars: out.text.length };
						log.debug("adapter.send", context(fields));
					},
				});
			});
			if (setup.mode === "socket") await bolt.start();
		},
		async stop(): Promise<void> {
			if (setup.mode === "socket") await app?.stop();
			app = undefined;
			activeLogger?.info("adapter.stop", { adapter: name, kind, mode: setup.mode });
		},
		async send(target: AdapterTarget, out: Outbound, start?: AdapterStart): Promise<void> {
			const log = start?.logger ?? activeLogger;
			const bolt = requiredSlackApp(app);
			const channel = await slackTargetChannel(bolt.client, target, delivery);
			await postPublicChunks({
				client: bolt.client,
				channel,
				text: out.text,
				approval: out.approval,
				thread: target.mode === "channel" ? undefined : target.thread,
				replyBroadcast: input.response?.broadcast ?? false,
				logger: log,
				context: { adapter: name, kind, channel, thread: target.thread },
				delivery,
			});
			const upload = await uploadSlackAttachments({
				client: bolt.client,
				store: start?.attachments,
				channel,
				thread: target.mode === "channel" ? undefined : target.thread,
				attachments: out.attachments,
				scope: out.attachmentScope,
				logger: log ?? { debug() {}, info() {}, warn() {}, error() {} },
				context: { adapter: name, kind, channel, thread: target.thread },
				delivery,
			});
			await postSlackAttachmentUploadNotice({
				client: bolt.client,
				channel,
				thread: target.mode === "channel" ? undefined : target.thread,
				upload,
				logger: log ?? { debug() {}, info() {}, warn() {}, error() {} },
				context: { adapter: name, kind, channel, thread: target.thread },
				delivery,
			});
			log?.debug("adapter.send", { adapter: name, kind, channel, thread: target.thread, chars: out.text.length });
		},
	};
}

function resolveSlackConfig(input: SlackConfig): ResolvedSlackConfig {
	return {
		...input,
		botToken: input.botToken ?? requiredEnv("SLACK_BOT_TOKEN", "Slack bot token"),
		appToken: ("appToken" in input ? input.appToken : undefined) ?? optionalEnv("SLACK_APP_TOKEN"),
		signingSecret: input.signingSecret ?? optionalEnv("SLACK_SIGNING_SECRET"),
	};
}

type SlackCommand = {
	text: string;
	user_id: string;
	team_id?: string;
	channel_id: string;
	channel_name?: string;
	trigger_id?: string;
};

async function handleCommand(input: {
	command: SlackCommand;
	client: SlackClient;
	handler: Handler;
	logger: Logger;
	delivery: DeliveryQueue;
	provider: string;
	adapterKind: string;
	commandName: string;
	groups: SlackGroupResolver;
	allow?: SlackAllow;
	messages?: AppMessages;
	attachments?: AttachmentStore;
}): Promise<void> {
	const command = input.command;
	const trace = command.trigger_id ? `slack:${command.trigger_id}` : undefined;
	const channel = command.channel_id;
	const actor = command.user_id;
	const context = (extra?: Record<string, unknown>) =>
		logCtx({ trace, adapter: input.provider, kind: input.adapterKind, channel }, extra);
	try {
		const actorGroups = await input.groups.forUser(input.client, actor);
		const allow = slackAllowed(input.allow, {
			channel,
			user: actor,
			groups: actorGroups,
			isDm: slackCommandDm(command),
		});
		if (!allow.ok) {
			input.logger.debug("adapter.drop", context({ actor, reason: allow.reason }));
			await postEphemeralChunks({
				client: input.client,
				channel,
				user: actor,
				text: "You are not allowed to use heypi here.",
				delivery: input.delivery,
			});
			return;
		}
		const text = nativeCommandText(command.text);
		const out = await input.handler({
			trace,
			provider: input.provider,
			kind: input.adapterKind,
			eventId: command.trigger_id,
			team: command.team_id,
			channel,
			actor,
			actorGroups,
			thread: channel,
			text,
			data: { command: input.commandName, text: command.text },
		});
		if (!out || out.silent) return;
		if (out.private) {
			await postEphemeralChunks({
				client: input.client,
				channel,
				user: actor,
				text: out.text,
				approval: out.approval,
				delivery: input.delivery,
			});
			return;
		}
		await postPublicChunks({
			client: input.client,
			channel,
			text: out.text,
			approval: out.approval,
			logger: input.logger,
			context: context(),
			delivery: input.delivery,
		});
		const upload = await uploadSlackAttachments({
			client: input.client,
			store: input.attachments,
			channel,
			attachments: out.attachments,
			scope: out.attachmentScope,
			logger: input.logger,
			context: context(),
			delivery: input.delivery,
		});
		await postSlackAttachmentUploadNotice({
			client: input.client,
			channel,
			upload,
			logger: input.logger,
			context: context(),
			delivery: input.delivery,
		});
	} catch (error) {
		input.logger.error("adapter.error", context({ error: errorMessage(error) }));
		await postEphemeralChunks({
			client: input.client,
			channel,
			user: actor,
			text: userError(input.messages?.error),
			delivery: input.delivery,
		}).catch(() => undefined);
	}
}

function slackCommandName(input: string | undefined): string {
	const value = input ?? "/heypi";
	if (!/^\/[a-z0-9_-]{1,31}$/u.test(value)) {
		throw new Error(
			"Slack command must start with / and contain 1-31 lowercase letters, numbers, underscores, or hyphens",
		);
	}
	return value;
}

function slackCommandDm(command: SlackCommand): boolean {
	return command.channel_id.startsWith("D") || command.channel_name === "directmessage";
}

function nativeCommandText(input: string): string {
	const trimmed = input.trim();
	if (!trimmed) return "/help";
	const [name, ...rest] = trimmed.split(/\s+/u);
	const command = name.toLowerCase();
	const args = rest.join(" ");
	return commandText(command, args) ?? "/help";
}

async function slackTargetChannel(
	client: SlackClient,
	target: AdapterTarget,
	delivery: DeliveryQueue,
): Promise<string> {
	if (target.channel) return target.channel;
	if (!target.user) throw new Error("Slack scheduled target requires channel or user");
	const user = target.user;
	const opened = await delivery.run(() => client.conversations.open({ users: user }), {
		adapter: "slack",
		user,
		delivery: "open_dm",
	});
	const channel = opened.channel?.id;
	if (!channel) throw new Error(`Slack DM target could not be opened for ${target.user}`);
	return channel;
}

function slackSetup(
	input: SlackConfig & (SlackSocketConfig | SlackHttpConfig),
	name: string,
):
	| { mode: "socket"; appToken: string; endpoints?: undefined; port?: undefined }
	| { mode: "http"; appToken?: undefined; endpoints: string | string[]; port?: number | string } {
	if (input.mode === "http") {
		if (!input.signingSecret) throw new Error("Slack HTTP mode requires signingSecret");
		if (input.path && !input.unsafePathOverride) {
			throw new Error("Slack HTTP path override requires unsafePathOverride: true");
		}
		return { mode: "http", endpoints: input.path ?? `/slack/${name}/events`, port: input.port };
	}
	if (!input.appToken) throw new Error("Slack socket mode requires appToken");
	return { mode: "socket", appToken: input.appToken };
}

function createSlackApp(
	input: SlackConfig,
	setup:
		| { mode: "socket"; appToken: string; endpoints?: undefined; port?: undefined }
		| { mode: "http"; appToken?: undefined; endpoints: string | string[]; port?: number | string },
	receiver?: HTTPReceiver,
): App {
	return new App({
		token: input.botToken,
		signingSecret: input.signingSecret ?? "",
		socketMode: setup.mode === "socket",
		appToken: setup.appToken,
		endpoints: setup.endpoints,
		receiver,
	});
}

function createSlackReceiver(
	input: SlackConfig,
	setup: { mode: "http"; endpoints: string | string[]; port?: number | string },
	start: AdapterStart,
): HTTPReceiver {
	if (!start.http) throw new Error("Slack HTTP mode requires the heypi HTTP registrar");
	const receiver = new HTTPReceiver({
		signingSecret: input.signingSecret ?? "",
		endpoints: setup.endpoints,
	});
	const endpoints = Array.isArray(setup.endpoints) ? setup.endpoints : [setup.endpoints];
	for (const path of endpoints) {
		start.http.register({
			method: "POST",
			path,
			port: setup.port,
			handler: receiver.requestListener,
		});
	}
	return receiver;
}

function requiredSlackApp(app: App | undefined): App {
	if (!app) throw new Error("Slack adapter is not started");
	return app;
}

function slackProgress(input: SlackConfig["progress"]): SlackProgress | undefined {
	return normalizeProgressConfig(input);
}

type SlackAttachmentUploadResult = {
	requested: number;
	resolved: number;
	uploaded: boolean;
};

export async function uploadSlackAttachments(input: {
	client: SlackClient;
	store?: AttachmentStore;
	channel: string;
	thread?: string;
	attachments?: Array<{ path: string; name?: string; mimeType?: string }>;
	scope?: ScopedKey;
	logger: Logger;
	context: Record<string, unknown>;
	delivery: DeliveryQueue;
}): Promise<SlackAttachmentUploadResult> {
	const requested = input.attachments?.length ?? 0;
	if (!requested) return { requested, resolved: 0, uploaded: true };
	const files = await resolveOutboundAttachments({
		provider: "slack",
		store: input.store,
		attachments: input.attachments,
		scope: input.scope,
		logger: input.logger,
		context: input.context,
	});
	if (!files.length) return { requested, resolved: 0, uploaded: false };
	try {
		await input.delivery.run(
			() =>
				input.client.files.uploadV2({
					channel_id: input.channel,
					thread_ts: input.thread,
					file_uploads: files.map((file) => ({
						file: file.path,
						filename: file.name,
						title: file.name,
					})),
				}),
			{ ...input.context, retry: "send" },
		);
		return { requested, resolved: files.length, uploaded: true };
	} catch (error) {
		input.logger.warn("slack.attachment_upload_failed", { ...input.context, error: errorMessage(error) });
		return { requested, resolved: files.length, uploaded: false };
	}
}

export async function postSlackAttachmentUploadNotice(input: {
	client: SlackClient;
	channel: string;
	thread?: string;
	upload: SlackAttachmentUploadResult;
	logger: Logger;
	context: Record<string, unknown>;
	delivery: DeliveryQueue;
}): Promise<void> {
	if (!input.upload.requested) return;
	if (input.upload.uploaded && input.upload.resolved === input.upload.requested) return;
	const text =
		input.upload.resolved > 0
			? "I created the file, but Slack did not accept the upload. Check the bot's `files:write` scope and server logs."
			: "I created the file, but heypi could not resolve it for upload. Check server logs for the attachment path error.";
	await postPublicChunks({
		client: input.client,
		channel: input.channel,
		thread: input.thread,
		text,
		logger: input.logger,
		context: input.context,
		delivery: input.delivery,
	});
}

async function postPublicChunks(input: {
	client: SlackClient;
	channel: string;
	text: string;
	approval?: Outbound["approval"];
	thread?: string;
	replyBroadcast?: boolean;
	skipFirst?: boolean;
	logger?: Logger;
	context?: Record<string, unknown>;
	delivery: DeliveryQueue;
}): Promise<void> {
	const chunks = slackChunks(input.text, Boolean(input.approval));
	for (let index = input.skipFirst ? 1 : 0; index < chunks.length; index++) {
		await input.delivery.run(
			() =>
				input.client.chat.postMessage(
					slackMessage({
						channel: input.channel,
						text: chunks[index],
						approval: index === 0 ? input.approval : undefined,
						thread: input.thread,
						replyBroadcast: input.replyBroadcast ?? false,
					}),
				),
			{ ...input.context, retry: "send" },
		);
	}
}

async function postEphemeralChunks(input: {
	client: SlackClient;
	channel: string;
	user: string;
	text: string;
	approval?: Outbound["approval"];
	thread?: string;
	delivery: DeliveryQueue;
}): Promise<void> {
	const chunks = slackChunks(input.text, Boolean(input.approval));
	for (let index = 0; index < chunks.length; index++) {
		const blocks = index === 0 ? approvalBlocks(input.approval) : undefined;
		const approvalPayload =
			blocks && input.approval
				? approvalAttachmentPayload(blocks, approvalFallbackText(input.text, input.approval), undefined, [
						approvalActionsBlock(input.approval),
					])
				: undefined;
		const message = {
			channel: input.channel,
			user: input.user,
			text: approvalPayload ? "" : chunks[index],
			thread_ts: input.thread,
			...(approvalPayload ?? {}),
		};
		await input.delivery.run(() => input.client.chat.postEphemeral(message), {
			adapter: "slack",
			channel: input.channel,
			user: input.user,
			retry: "send",
		});
	}
}

function slackReplyStream(input: {
	config?: ReplyStreamOption;
	client: SlackClient;
	channel: string;
	thread?: string;
	approval?: Outbound["approval"];
	logger: Logger;
	context: Record<string, unknown>;
	delivery: DeliveryQueue;
	takeoverFirstMessage?: () => Promise<string | undefined>;
}) {
	if (!input.config || (typeof input.config === "object" && input.config.enabled === false)) return undefined;
	return new DraftReplyStream(
		{
			limit: SLACK_TEXT_LIMIT,
			create: async (text) => {
				const adopted = await input.takeoverFirstMessage?.();
				if (adopted) {
					await input.delivery.run(
						() =>
							input.client.chat.update({
								channel: input.channel,
								ts: adopted,
								text,
								blocks: [],
							}),
						input.context,
					);
					return adopted;
				}
				const res = await input.delivery.run(
					() =>
						input.client.chat.postMessage(
							slackMessage({
								channel: input.channel,
								text,
								thread: input.thread,
								replyBroadcast: false,
							}),
						),
					{ ...input.context, retry: "send" },
				);
				const ts = typeof res.ts === "string" ? res.ts : undefined;
				if (!ts) throw new Error("Slack stream message missing ts");
				return ts;
			},
			edit: async (id, text) => {
				await input.delivery.run(
					() =>
						input.client.chat.update({
							channel: input.channel,
							ts: id,
							text,
							blocks: [],
						}),
					input.context,
				);
			},
			delete: async (id) => {
				await input.delivery.run(
					() =>
						input.client.chat.delete({
							channel: input.channel,
							ts: id,
						}),
					input.context,
				);
			},
		},
		input.config,
		input.logger,
		input.context,
	);
}

function slackChunks(text: string, hasBlocks: boolean): string[] {
	return chunkText(text, hasBlocks ? SLACK_BLOCK_TEXT_LIMIT : SLACK_TEXT_LIMIT);
}

export function startProgress(input: {
	channel: string;
	source?: string;
	target?: string;
	client: SlackClient;
	progress?: SlackProgress;
	cancelId?: string;
	logger: Logger;
	context: Record<string, unknown>;
	delivery: DeliveryQueue;
}) {
	let active = true;
	let reacted = false;
	let placeholder: string | undefined;
	let placeholderTask: Promise<void> | undefined;
	let placeholderTimer: ReturnType<typeof setTimeout> | undefined;
	let resolvePlaceholderTask: (() => void) | undefined;
	const reaction = input.progress ? (input.progress.reaction ?? "eyes") : false;
	let message = input.progress ? (input.progress.message ?? "Working...") : false;

	const finishPlaceholderTask = () => {
		const resolve = resolvePlaceholderTask;
		resolvePlaceholderTask = undefined;
		placeholderTask = undefined;
		resolve?.();
	};
	const cancelPlaceholderTimer = () => {
		if (!placeholderTimer) return;
		clearTimeout(placeholderTimer);
		placeholderTimer = undefined;
		finishPlaceholderTask();
	};
	const removeReaction = async () => {
		if (reacted && reaction && input.source) {
			const source = input.source;
			reacted = false;
			await input.delivery
				.run(() => input.client.reactions.remove({ channel: input.channel, timestamp: source, name: reaction }), {
					...input.context,
					delivery: "reaction_remove",
				})
				.catch((error) => {
					input.logger.warn("slack.progress.reaction_remove_failed", {
						...input.context,
						error: errorMessage(error),
					});
				});
		}
	};

	if (reaction && input.target && input.source) {
		const source = input.source;
		input.delivery
			.run(() => input.client.reactions.add({ channel: input.channel, timestamp: source, name: reaction }), {
				...input.context,
				delivery: "reaction",
			})
			.then(() => {
				reacted = true;
			})
			.catch((error) => {
				input.logger.warn("slack.progress.reaction_failed", { ...input.context, error: errorMessage(error) });
			});
	}

	const delay = input.progress?.delayMs ?? 750;
	if (message) {
		placeholderTask = new Promise((resolve) => {
			resolvePlaceholderTask = resolve;
			placeholderTimer = setTimeout(() => {
				placeholderTimer = undefined;
				if (!active) {
					finishPlaceholderTask();
					return;
				}
				const progressText = message;
				if (progressText === false) {
					finishPlaceholderTask();
					return;
				}
				input.delivery
					.run(
						() =>
							input.client.chat.postMessage(
								input.cancelId
									? {
											channel: input.channel,
											text: progressText,
											thread_ts: input.target,
											blocks: cancelBlocks(progressText, input.cancelId),
										}
									: {
											channel: input.channel,
											text: progressText,
											thread_ts: input.target,
										},
							),
						{ ...input.context, delivery: "progress", retry: "send" },
					)
					.then((out) => {
						placeholder = out.ts;
					})
					.catch((error) => {
						input.logger.warn("slack.progress.message_failed", { ...input.context, error: errorMessage(error) });
					})
					.finally(finishPlaceholderTask);
			}, delay);
		});
	}

	return {
		async notify(text: string): Promise<void> {
			if (message === false) return;
			message = text;
			if (!placeholder) return;
			const ts = placeholder;
			await input.delivery
				.run(
					() =>
						input.client.chat.update(
							input.cancelId
								? {
										channel: input.channel,
										ts,
										text,
										blocks: cancelBlocks(text, input.cancelId),
									}
								: {
										channel: input.channel,
										ts,
										text,
									},
						),
					{ ...input.context, delivery: "progress_notify" },
				)
				.catch((error) => {
					input.logger.warn("slack.progress.notify_failed", { ...input.context, error: errorMessage(error) });
				});
		},
		async update(text: string, approval?: Outbound["approval"]): Promise<boolean> {
			active = false;
			cancelPlaceholderTimer();
			await placeholderTask;
			if (!placeholder) return false;
			const ts = placeholder;
			placeholder = undefined;
			try {
				const chunks = slackChunks(text, Boolean(approval));
				const first = chunks[0] ?? "";
				const blocks = approvalBlocks(approval);
				const approvalPayload =
					blocks && approval
						? approvalAttachmentPayload(blocks, approvalFallbackText(text, approval), undefined, [
								approvalActionsBlock(approval),
							])
						: undefined;
				await input.delivery.run(
					() =>
						input.client.chat.update(
							approvalPayload
								? { channel: input.channel, ts, text: "", ...approvalPayload }
								: { channel: input.channel, ts, text: first },
						),
					{ ...input.context, delivery: "progress_update" },
				);
				return true;
			} catch (error) {
				input.logger.warn("slack.progress.update_failed", { ...input.context, error: errorMessage(error) });
				return false;
			}
		},
		async takeover(): Promise<string | undefined> {
			active = false;
			cancelPlaceholderTimer();
			await placeholderTask;
			const ts = placeholder;
			placeholder = undefined;
			await removeReaction();
			return ts;
		},
		async stop(): Promise<void> {
			active = false;
			cancelPlaceholderTimer();
			await placeholderTask;
			if (placeholder) {
				const ts = placeholder;
				placeholder = undefined;
				await input.delivery
					.run(() => input.client.chat.delete({ channel: input.channel, ts }), {
						...input.context,
						delivery: "progress_delete",
					})
					.catch((error) => {
						input.logger.warn("slack.progress.delete_failed", { ...input.context, error: errorMessage(error) });
					});
			}
			await removeReaction();
		},
	};
}

function target(mode: SlackReply, msg: { channel?: string; ts?: string; thread_ts?: string }) {
	if (mode === "channel") return {};
	if (mode === "same") return { thread: msg.thread_ts };
	if (msg.channel?.startsWith("D")) return {};
	return { thread: msg.thread_ts ?? msg.ts };
}

function slackPlacement(response: SlackResponse | undefined): SlackReply {
	return response?.placement === "auto" || response?.placement === undefined ? "thread" : response.placement;
}

function threadKey(mode: SlackReply, msg: { channel?: string; ts?: string; thread_ts?: string }) {
	const channel = msg.channel ?? "unknown";
	if (channel.startsWith("D")) return `${channel}:${channel}`;
	if (mode === "thread") return `${channel}:${msg.thread_ts ?? msg.ts ?? channel}`;
	if (mode === "same" && msg.thread_ts) return `${channel}:${msg.thread_ts}`;
	return `${channel}:${channel}`;
}

function shouldReact(mode: SlackReply, msg: { channel?: string; ts?: string; thread_ts?: string }) {
	return mode === "thread" && !msg.channel?.startsWith("D") && !msg.thread_ts && !!msg.ts;
}

export function slackMessageSubtypeAllowed(subtype: string | undefined, bot = false): boolean {
	return subtype === undefined || subtype === "file_share" || (bot && subtype === "bot_message");
}

export type SlackBotIdentity = {
	botId?: string;
	appId?: string;
	userId?: string;
};

async function slackBotIdentity(client: SlackClient, logger: Logger): Promise<SlackBotIdentity> {
	try {
		const out = (await client.auth.test()) as { bot_id?: string; app_id?: string; user_id?: string };
		return { botId: out.bot_id, appId: out.app_id, userId: out.user_id };
	} catch (error) {
		logger.warn("slack.auth_test_failed", { adapter: "slack", error: errorMessage(error) });
		return {};
	}
}

function slackDm(msg: { channel?: string; channel_type?: string }): boolean {
	return msg.channel_type === "im" || msg.channel?.startsWith("D") === true;
}

function slackAllowConfigured(allow: SlackAllow | undefined): boolean {
	return Boolean(
		allow?.channels?.length ||
			allow?.users?.length ||
			allow?.groups?.length ||
			botAllowConfigured(allow?.bots) ||
			allow?.dms === false,
	);
}

export function slackAllowed(
	allow: SlackAllow | undefined,
	event: {
		channel?: string;
		user?: string;
		groups?: string[];
		bot?: SlackBotIdentity;
		botSelf?: SlackBotIdentity;
		isDm: boolean;
	},
): { ok: true } | { ok: false; reason: string } {
	return allowByDimensions({
		dms: allow?.dms,
		isDm: event.isDm,
		dmReason: "dm_not_allowed",
		dimensions: [
			{ allowlist: allow?.channels, value: event.channel, reason: "channel_not_allowed", skip: event.isDm },
			{ allowlist: actorAllowlist(allow), value: slackActorValue(allow, event), reason: "actor_not_allowed" },
		],
	});
}

function slackActorValue(
	allow: SlackAllow | undefined,
	event: { user?: string; groups?: string[]; bot?: SlackBotIdentity; botSelf?: SlackBotIdentity },
): string | undefined {
	return actorAllowedValue({
		allow,
		user: event.user,
		groups: event.groups,
		botAllowed: event.bot ? slackBotAllowed(allow?.bots, event.bot, event.botSelf) : undefined,
	});
}

export function slackBotAllowed(
	allow: SlackAllow["bots"] | undefined,
	bot: SlackBotIdentity,
	self: SlackBotIdentity | undefined,
): boolean {
	return botIdentityAllowed({
		allow,
		botIds: [bot.botId, bot.appId, bot.userId],
		selfIds: [self?.botId, self?.appId, self?.userId],
	});
}

function slackBotSender(
	msg: {
		subtype?: string;
		bot_id?: string;
		app_id?: string;
		user?: string;
	},
	self: SlackBotIdentity = {},
): SlackBotIdentity | undefined {
	if (msg.subtype !== "bot_message" && !msg.bot_id && !msg.app_id && msg.user !== self.userId) return undefined;
	return { botId: msg.bot_id, appId: msg.app_id, userId: msg.user };
}

function slackActor(msg: { user?: string }, bot?: SlackBotIdentity): string {
	return msg.user ?? bot?.botId ?? bot?.appId ?? "unknown";
}

export function slackTriggered(
	trigger: SlackTrigger | undefined,
	event: {
		text?: string;
		type?: string;
		isDm: boolean;
		botUserId?: string;
		thread?: boolean;
		threadTrigger?: SlackTrigger | false;
	},
): { ok: true } | { ok: false; reason: string } {
	return messageTriggered({
		trigger,
		isDm: event.isDm,
		thread: event.thread,
		threadTrigger: event.threadTrigger,
		mentioned:
			event.type === "app_mention" || Boolean(event.botUserId && event.text?.includes(`<@${event.botUserId}>`)),
		text: event.text,
		reason: "mention_required",
	});
}

type SlackClient = AllMiddlewareArgs["client"];
type SlackMessage = Parameters<SlackClient["chat"]["postMessage"]>[0];
type SlackBlock = types.Block | types.KnownBlock;
type SlackAttachment = { color: string; fallback: string; blocks: SlackBlock[] };
type SlackUpdate = { text: string; blocks?: SlackBlock[]; attachments?: SlackAttachment[] };

const SLACK_GROUP_CACHE_MS = 60_000;

export class SlackGroupResolver {
	private readonly groups: string[];
	private readonly cache = new Map<string, { groups: string[]; expiresAt: number }>();

	constructor(
		groups: string[],
		private readonly logger: Logger,
	) {
		this.groups = [...new Set(groups)];
	}

	async forUser(client: SlackClient, user?: string): Promise<string[]> {
		if (!user || this.groups.length === 0) return [];
		const cached = this.cache.get(user);
		if (cached && cached.expiresAt > Date.now()) return cached.groups;
		const groups: string[] = [];
		for (const group of this.groups) {
			try {
				const response = await client.usergroups.users.list({ usergroup: group });
				if (response.users?.includes(user)) groups.push(group);
			} catch (error) {
				this.logger.warn("slack.usergroup_lookup_failed", { group, user, error: errorMessage(error) });
			}
		}
		this.cache.set(user, { groups, expiresAt: Date.now() + SLACK_GROUP_CACHE_MS });
		return groups;
	}
}

type SlackFile = {
	id?: string;
	name?: string;
	title?: string;
	mimetype?: string;
	size?: number;
	url_private?: string;
	url_private_download?: string;
};

async function slackAttachments(input: {
	store?: AttachmentStore;
	files?: SlackFile[];
	scope?: ScopedKey;
	token: string;
	provider: string;
	kind: string;
	messageId?: string;
	trace?: string;
	logger: Logger;
}): Promise<Attachment[] | undefined> {
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
		refs: slackPolicyFiles(input.files),
		download: async (file) => {
			const url = file.sourceUrl;
			assertSlackFileUrl(url);
			const response = await fetch(url, { headers: { Authorization: `Bearer ${input.token}` } });
			if (!response.ok) throw new Error(`Slack file download failed: ${response.status}`);
			return await responseBytes(response, maxBytes);
		},
	});
}

type SlackPolicyFile = {
	id?: string;
	name: string;
	mimeType?: string;
	size?: number;
	sourceUrl: string;
};

function slackPolicyFiles(files: SlackFile[] | undefined): SlackPolicyFile[] {
	const out: SlackPolicyFile[] = [];
	for (const file of files ?? []) {
		const url = file.url_private_download ?? file.url_private;
		if (!url) continue;
		out.push({
			id: file.id,
			name: file.name ?? file.title ?? file.id ?? "attachment",
			mimeType: file.mimetype,
			size: file.size,
			sourceUrl: url,
		});
	}
	return out;
}

function assertSlackFileUrl(input: string): void {
	const url = new URL(input);
	if (url.protocol !== "https:") throw new Error(`Slack file URL must use https: ${url.protocol}`);
	// Slack file fetches attach the bot token, so never send them to attacker-controlled hosts.
	if (!slackFileHost(url.hostname)) throw new Error(`Slack file URL host is not allowed: ${url.hostname}`);
}

function slackFileHost(host: string): boolean {
	return host === "slack.com" || host.endsWith(".slack.com") || host.endsWith(".slack-edge.com");
}

export async function handleAction(input: {
	kind: "approve" | "deny" | "cancel" | "status";
	body: unknown;
	action: unknown;
	client: SlackClient;
	handler: Handler;
	logger: Logger;
	delivery: DeliveryQueue;
	provider: string;
	adapterKind: string;
	groups: SlackGroupResolver;
	progress?: SlackConfig["progress"];
	streaming?: ReplyStreamOption;
	messages?: AppMessages;
	attachments?: AttachmentStore;
}): Promise<void> {
	const value = stringProp(record(input.action), "value");
	const context = actionContext(input.body);
	if (!context.channel || !context.actor) return;
	if (!value && input.kind !== "status") return;
	const actionChannel = context.channel;
	const actionActor = context.actor;
	const actorGroups = await input.groups.forUser(input.client, actionActor);
	const trace = `${input.kind}:${value ?? context.message ?? context.trigger ?? Date.now()}`;
	const target = context.threadTs ?? context.message;
	const logContext = (extra?: Record<string, unknown>) =>
		logCtx({ trace, adapter: input.provider, kind: input.adapterKind, channel: actionChannel }, extra);
	let acknowledged = false;
	let progress: ReturnType<typeof startProgress> | undefined;
	const acknowledge = async (out: Outbound) => {
		const actionMessage = context.message;
		if (!actionMessage) return;
		const update = slackApprovalUpdate(out, "approved", actionActor, input.body);
		if (!hasApprovalPayload(update)) throw new Error("Slack approval acknowledgement missing approval blocks");
		await input.delivery.run(
			() =>
				input.client.chat.update({
					channel: actionChannel,
					ts: actionMessage,
					...update,
				}),
			logContext(),
		);
		acknowledged = true;
		if (input.kind === "approve" && target) {
			progress = startProgress({
				channel: actionChannel,
				source: actionMessage,
				target,
				client: input.client,
				progress: { ...slackProgress(input.progress), reaction: false },
				cancelId: trace,
				logger: input.logger,
				context: logContext({ thread: target }),
				delivery: input.delivery,
			});
		}
	};
	const replace = async (out: Outbound) => {
		const actionMessage = context.message;
		if (!actionMessage) throw new Error("Slack approval action missing message");
		const state = out.approvalResolution;
		if (!state) throw new Error("Slack approval replacement missing resolution");
		const update = slackApprovalUpdate(out, state, actionActor, input.body);
		if (!hasApprovalPayload(update)) throw new Error("Slack approval action missing approval blocks");
		await input.delivery.run(
			() =>
				input.client.chat.update({
					channel: actionChannel,
					ts: actionMessage,
					...update,
				}),
			logContext(),
		);
	};
	const stream =
		input.kind === "approve" && target
			? slackReplyStream({
					config: input.streaming,
					client: input.client,
					channel: context.channel,
					thread: target,
					approval: undefined,
					logger: input.logger,
					context: logContext({ channel: context.channel, thread: target }),
					delivery: input.delivery,
					takeoverFirstMessage: () => progress?.takeover() ?? Promise.resolve(undefined),
				})
			: undefined;
	try {
		const out = await input.handler({
			trace,
			provider: input.provider,
			kind: input.adapterKind,
			eventId: trace,
			team: context.team,
			channel: context.channel,
			actor: context.actor,
			actorGroups,
			thread: context.thread,
			text: input.kind === "status" ? "/status" : `/${input.kind} ${value}`,
			data: input.body,
			stream,
			ack: input.kind === "approve" ? (out) => acknowledge(out) : undefined,
			replace: input.kind === "approve" || input.kind === "deny" ? replace : undefined,
		});
		if (!out) return;
		if (out.silent) {
			await stream?.clear?.();
			return;
		}
		if (out.private || !context.message) {
			await stream?.clear?.();
			const channel = context.channel;
			const actor = context.actor;
			if (out.replaceOriginal && context.message) {
				const update = slackApprovalUpdate(out, out.approvalResolution, actor, input.body);
				if (hasApprovalPayload(update)) {
					try {
						await input.delivery.run(
							() =>
								input.client.chat.update({
									channel,
									ts: context.message as string,
									...update,
								}),
							logContext({ channel }),
						);
						input.logger.debug("adapter.send", logContext({ channel: context.channel, update: true }));
						return;
					} catch (error) {
						input.logger.warn(
							"slack.approval_update_failed",
							logContext({ channel, error: errorMessage(error) }),
						);
					}
				}
			}
			await postEphemeralChunks({
				client: input.client,
				channel,
				user: actor,
				text: out.text,
				thread: context.threadTs ?? context.message,
				delivery: input.delivery,
			});
			input.logger.debug("adapter.send", logContext({ channel: context.channel, private: true }));
			return;
		}
		const channel = context.channel;
		const message = context.message;
		const resolution = out.approvalResolution;
		if ((input.kind === "approve" || input.kind === "deny") && out.approval && resolution) {
			const update = slackApprovalUpdate(out, resolution, context.actor, input.body);
			await input.delivery.run(
				() =>
					input.client.chat.update({
						channel,
						ts: message,
						...update,
					}),
				logContext({ channel }),
			);
			input.logger.debug("adapter.send", logContext({ channel: context.channel, update: true }));
			if (input.kind === "deny") return;
		}
		const chunks = slackChunks(out.text, true);
		const streamed = Boolean(stream?.complete?.() && input.kind === "approve");
		if (acknowledged) {
			const thread = context.threadTs ?? message;
			if (streamed) {
				await progress?.stop();
			} else {
				const sent = await progress?.update(out.text, out.approval);
				await postPublicChunks({
					client: input.client,
					channel,
					text: out.text,
					approval: sent ? undefined : out.approval,
					thread,
					skipFirst: sent,
					logger: input.logger,
					context: logContext({ channel, thread }),
					delivery: input.delivery,
				});
			}
			const upload = await uploadSlackAttachments({
				client: input.client,
				store: input.attachments,
				channel,
				thread,
				attachments: out.attachments,
				scope: out.attachmentScope,
				logger: input.logger,
				context: logContext({ channel, thread }),
				delivery: input.delivery,
			});
			await postSlackAttachmentUploadNotice({
				client: input.client,
				channel,
				thread,
				upload,
				logger: input.logger,
				context: logContext({ channel, thread }),
				delivery: input.delivery,
			});
			input.logger.debug("adapter.send", logContext({ channel: context.channel, update: true }));
			return;
		}
		if (input.kind === "approve") {
			const thread = context.threadTs ?? message;
			if (streamed) {
				await progress?.stop();
			} else {
				await postPublicChunks({
					client: input.client,
					channel,
					text: out.text,
					approval: out.approval,
					thread,
					logger: input.logger,
					context: logContext({ channel, thread }),
					delivery: input.delivery,
				});
			}
			const upload = await uploadSlackAttachments({
				client: input.client,
				store: input.attachments,
				channel,
				thread,
				attachments: out.attachments,
				scope: out.attachmentScope,
				logger: input.logger,
				context: logContext({ channel, thread }),
				delivery: input.delivery,
			});
			await postSlackAttachmentUploadNotice({
				client: input.client,
				channel,
				thread,
				upload,
				logger: input.logger,
				context: logContext({ channel, thread }),
				delivery: input.delivery,
			});
			input.logger.debug("adapter.send", logContext({ channel: context.channel, update: true }));
			return;
		}
		const first = streamed ? "" : (chunks[0] ?? "");
		if (streamed) {
			await progress?.stop();
		}
		await input.delivery.run(
			() =>
				input.client.chat.update({
					channel,
					ts: message,
					text: first,
					blocks: [{ type: "section", text: { type: "mrkdwn", text: first } }],
				}),
			logContext({ channel }),
		);
		for (let index = streamed ? chunks.length : 1; index < chunks.length; index++) {
			await input.delivery.run(
				() =>
					input.client.chat.postMessage({
						channel,
						text: chunks[index],
						thread_ts: context.threadTs ?? message,
					}),
				logContext({ channel, retry: "send" }),
			);
		}
		input.logger.debug("adapter.send", logContext({ channel: context.channel, update: true }));
	} catch (error) {
		await stream?.stop();
		input.logger.error(
			"adapter.error",
			logContext({
				channel: context.channel,
				actor: context.actor,
				error: errorMessage(error),
			}),
		);
		if ((input.kind === "approve" || input.kind === "deny") && context.message) {
			await postEphemeralChunks({
				client: input.client,
				channel: context.channel,
				user: context.actor,
				text: userError(input.messages?.error),
				thread: context.threadTs ?? context.message,
				delivery: input.delivery,
			}).catch(() => undefined);
			return;
		}
		if (context.message) {
			const text = userError(input.messages?.error);
			await input.client.chat
				.update({
					channel: context.channel,
					ts: context.message,
					text,
					blocks: [{ type: "section", text: { type: "mrkdwn", text } }],
				})
				.catch(() => undefined);
		}
	} finally {
		await progress?.stop();
	}
}

function slackApprovalUpdate(
	out: Outbound,
	state: Outbound["approvalResolution"],
	actor: string,
	body: unknown,
): SlackUpdate {
	const text = slackApprovalFallbackText(out, state, actor);
	const blocks = slackResolvedApprovalBlocks(out, state, actor, body);
	return blocks ? { text: "", blocks: [], ...approvalAttachmentPayload(blocks, text, state) } : { text };
}

function slackResolvedApprovalBlocks(
	out: Outbound,
	state: Outbound["approvalResolution"],
	actor: string,
	body: unknown,
): SlackBlock[] | undefined {
	if (out.approval && state) return approvalBlocks(out.approval, state, actor);
	const blocks = approvalBlocksFromPayload(body);
	if (!blocks) return undefined;
	return resolveApprovalBlocks(blocks, {
		title: state ? approvalTitleText(state) : undefined,
		status: state ? approvalResolutionText(state, actor) : out.text,
	});
}

function slackApprovalFallbackText(out: Outbound, state: Outbound["approvalResolution"], actor: string): string {
	if (!out.approval || !state) return out.text;
	return [out.approval.reason, approvalResolutionText(state, actor)].filter(Boolean).join("\n");
}

function approvalResolutionText(state: NonNullable<Outbound["approvalResolution"]>, actor?: string): string {
	return approvalStateLine(state, actor ? `<@${actor}>` : undefined);
}

function cancelBlocks(text: string, id: string): SlackBlock[] {
	return [
		{ type: "section", text: { type: "mrkdwn", text } },
		{
			type: "actions",
			elements: [
				{
					type: "button",
					text: { type: "plain_text", text: controlActionLabel("cancel") },
					style: "danger",
					action_id: CANCEL,
					value: id,
				},
				{
					type: "button",
					text: { type: "plain_text", text: controlActionLabel("status") },
					action_id: STATUS,
					value: "thread",
				},
			],
		},
	];
}

function slackMessage(input: {
	channel: string;
	text: string;
	approval?: Outbound["approval"];
	thread?: string;
	replyBroadcast?: boolean;
}): SlackMessage {
	const blocks = approvalBlocks(input.approval);
	const base: Record<string, unknown> = {
		channel: input.channel,
		text: input.text,
	};
	if (input.thread) {
		base.thread_ts = input.thread;
		base.reply_broadcast = input.replyBroadcast ?? false;
	}
	if (blocks && input.approval) {
		base.text = "";
		Object.assign(
			base,
			approvalAttachmentPayload(blocks, approvalFallbackText(input.text, input.approval), undefined, [
				approvalActionsBlock(input.approval),
			]),
		);
	}
	return base as unknown as SlackMessage;
}

function approvalAttachmentPayload(
	blocks: SlackBlock[],
	fallback: string,
	state?: Outbound["approvalResolution"],
	actions?: SlackBlock[],
): { attachments: SlackAttachment[]; blocks?: SlackBlock[] } {
	return {
		attachments: [{ color: approvalColor(state), fallback, blocks }],
		...(actions?.length ? { blocks: actions } : {}),
	};
}

function approvalFallbackText(text: string, approval: NonNullable<Outbound["approval"]>): string {
	return [approvalTitleText(undefined).replaceAll("*", ""), approval.reason ?? text, `Approval ID ${approval.id}`]
		.filter(Boolean)
		.join("\n");
}

function approvalAttachmentBlocks(message: Record<string, unknown> | undefined): unknown {
	const attachments = message?.attachments;
	if (!Array.isArray(attachments)) return undefined;
	for (const attachment of attachments) {
		const blocks = record(attachment)?.blocks;
		if (Array.isArray(blocks)) return blocks;
	}
	return undefined;
}

function approvalColor(state?: Outbound["approvalResolution"]): string {
	if (state === "approved") return APPROVAL_APPROVED_COLOR;
	if (state === "rejected") return APPROVAL_REJECTED_COLOR;
	if (state === "expired") return APPROVAL_EXPIRED_COLOR;
	return APPROVAL_PENDING_COLOR;
}

function hasApprovalPayload(update: SlackUpdate): boolean {
	return Boolean(update.blocks?.length || update.attachments?.length);
}

export function approvalBlocks(
	approval?: Outbound["approval"],
	state?: Outbound["approvalResolution"],
	actor?: string,
): SlackBlock[] | undefined {
	if (!approval) return undefined;
	const rows = approvalViewRows({
		approval,
		state: state ?? "pending",
		actor,
		formatActor: (id) => `<@${id}>`,
	});
	const blocks: SlackBlock[] = [
		{ type: "section", text: { type: "mrkdwn", text: approvalTitleText(state) } },
		...rows
			.filter((row) => row.label !== "Approval ID" && row.label !== "Requested by" && !row.label.endsWith(" by"))
			.flatMap((row) => labeledBlock(row.label, row.format === "code" ? codeFence(row.value) : row.value)),
		metadataBlock(rows),
	];
	return blocks;
}

function approvalActionsBlock(approval: NonNullable<Outbound["approval"]>): SlackBlock {
	return {
		type: "actions",
		elements: [
			{
				type: "button",
				text: { type: "plain_text", text: controlActionLabel("approve") },
				style: "primary",
				action_id: APPROVE,
				value: approval.id,
			},
			{
				type: "button",
				text: { type: "plain_text", text: controlActionLabel("deny") },
				style: "danger",
				action_id: DENY,
				value: approval.id,
			},
		],
	};
}

function approvalBlocksFromPayload(body: unknown): SlackBlock[] | undefined {
	const message = record(record(body)?.message);
	const blocks = approvalAttachmentBlocks(message) ?? message?.blocks;
	if (!Array.isArray(blocks)) return undefined;
	return blocks.map((block) => stripSlackBlockId(block as SlackBlock));
}

function resolveApprovalBlocks(
	blocks: SlackBlock[],
	resolution: { title?: string; status: string },
): SlackBlock[] | undefined {
	const next = [...blocks];
	if (resolution.title) {
		const title = approvalTitleIndex(next);
		if (title >= 0) next[title] = { type: "section", text: { type: "mrkdwn", text: resolution.title } };
	}
	const metadata = approvalMetadataIndex(next);
	if (metadata >= 0) {
		next[metadata] = appendMetadataStatus(next[metadata], resolution.status);
	} else {
		next.push(contextBlock(resolution.status)[0]);
	}
	return next;
}

function approvalTitleIndex(blocks: SlackBlock[]): number {
	for (const [index, block] of blocks.entries()) {
		const value = record(block);
		const text = stringProp(record(value?.text), "text");
		if (text?.startsWith("*Approval ")) return index;
	}
	return -1;
}

function approvalMetadataIndex(blocks: SlackBlock[]): number {
	for (const [index, block] of blocks.entries()) {
		const value = record(block);
		const text = stringProp(record(value?.text), "text");
		if (text?.includes("*Approval ID*")) return index;
	}
	return -1;
}

function appendMetadataStatus(block: SlackBlock, status: string): SlackBlock {
	const value = record(block);
	const text = stringProp(record(value?.text), "text");
	if (!text) return block;
	return {
		type: "section",
		text: { type: "mrkdwn", text: `${text}\n${status}` },
	};
}

function stripSlackBlockId(block: SlackBlock): SlackBlock {
	const value = { ...(block as unknown as Record<string, unknown>) };
	delete value.block_id;
	return value as unknown as SlackBlock;
}

function approvalTitleText(state?: Outbound["approvalResolution"]): string {
	return `*${approvalViewTitle(state ?? "pending")}*`;
}

function labeledBlock(label: string, value: string): SlackBlock[] {
	return [{ type: "section", text: { type: "mrkdwn", text: `*${label}*\n${value}` } }];
}

function metadataBlock(rows: ReturnType<typeof approvalViewRows>): SlackBlock {
	const metadata = rows.filter(
		(row) =>
			row.label === "Approval ID" ||
			row.label === "Requested by" ||
			row.label.endsWith(" by") ||
			row.label === "Status",
	);
	const lines = metadata.map((row) =>
		row.label === "Approval ID" ? `*${row.label}* \`${row.value}\`` : `*${row.label}* ${row.value}`,
	);
	return {
		type: "section",
		text: { type: "mrkdwn", text: lines.join("\n") },
	};
}

function contextBlock(text: string): SlackBlock[] {
	return [{ type: "context", elements: [{ type: "mrkdwn", text }] }];
}

function actionContext(body: unknown) {
	const root = record(body);
	const channel = stringProp(record(root?.channel), "id");
	const actor = stringProp(record(root?.user), "id");
	const message = record(root?.message);
	const messageTs = stringProp(message, "ts");
	const threadTs = stringProp(message, "thread_ts");
	const trigger = stringProp(root, "trigger_id");
	const team = slackTeam(body);
	return {
		channel,
		team,
		actor,
		message: messageTs,
		trigger,
		threadTs,
		thread: channel ? `${channel}:${threadTs ?? messageTs ?? channel}` : "unknown",
	};
}

function slackTeam(body: unknown): string | undefined {
	const root = record(body);
	return stringProp(root, "team_id") ?? stringProp(record(root?.team), "id");
}

function record(value: unknown): Record<string, unknown> | undefined {
	return value && typeof value === "object" ? (value as Record<string, unknown>) : undefined;
}

function stringProp(input: Record<string, unknown> | undefined, key: string): string | undefined {
	const value = input?.[key];
	return typeof value === "string" ? value : undefined;
}
