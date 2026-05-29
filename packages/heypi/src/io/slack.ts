import { type AllMiddlewareArgs, App, HTTPReceiver, type types } from "@slack/bolt";
import { approvalStateLine, approvalStateTitle, codeFence } from "../core/approval-view.js";
import { message as errorMessage, type Logger, userError } from "../core/log.js";
import type { AppMessages } from "../core/messages.js";
import type { ScopedKey } from "../core/scope.js";
import { chunkText } from "../render/chunk.js";
import { resolveOutboundAttachments, saveInboundAttachments } from "./attachment-policy.js";
import { type Attachment, type AttachmentStore, responseBytes } from "./attachments.js";
import { runChatMessage } from "./chat-message.js";
import { type DeliveryConfig, DeliveryQueue } from "./delivery.js";
import { allowByDimensions, messageTriggered } from "./gate.js";
import type { Adapter, AdapterStart, AdapterTarget, Handler, Outbound } from "./handler.js";
import { logCtx } from "./log-context.js";
import { assertRouteName } from "./name.js";
import { DraftReplyStream, type ReplyStreamOption } from "./reply-stream.js";

const APPROVE = "heypi_approve";
const DENY = "heypi_deny";
const CANCEL = "heypi_cancel";
const STATUS = "heypi_status";
const SLACK_TEXT_LIMIT = 4000;
const SLACK_BLOCK_TEXT_LIMIT = 3000;

export type SlackConfig = {
	name?: string;
	botToken: string;
	allow?: SlackAllow;
	trigger?: SlackTrigger;
	threadTrigger?: SlackTrigger | false;
	reply?: SlackReply;
	replyBroadcast?: boolean;
	progress?: SlackProgress | false;
	streaming?: ReplyStreamOption;
	delivery?: DeliveryConfig | false;
} & (SlackSocketConfig | SlackHttpConfig);

export type SlackSocketConfig = {
	mode?: "socket";
	appToken: string;
	signingSecret?: string;
};

export type SlackHttpConfig = {
	mode: "http";
	signingSecret: string;
	port?: number | string;
	path?: string | string[];
	unsafePathOverride?: boolean;
};

export type SlackReply = "thread" | "same" | "channel";
export type SlackTrigger = "mention" | "message";

export type SlackAllow = {
	teams?: string[];
	channels?: string[];
	users?: string[];
	dms?: boolean;
};

export type SlackProgress = {
	reaction?: string | false;
	message?: string | false;
	delayMs?: number;
};

/** Creates the Slack adapter using Socket Mode or Slack's HTTP receiver. */
export function slack(input: SlackConfig): Adapter {
	const name = input.name ?? "slack";
	assertRouteName(name);
	const setup = slackSetup(input, name);
	const kind = "slack";
	let app: App | undefined;
	let activeLogger: Logger | undefined;
	let delivery = new DeliveryQueue(input.delivery);
	let botUserId: string | undefined;

	return {
		name,
		kind,
		async start(start: AdapterStart): Promise<void> {
			const { handler, logger: log } = start;
			activeLogger = log;
			delivery = new DeliveryQueue(input.delivery, log);
			log.info("adapter.start", { adapter: name, kind, mode: setup.mode });
			const receiver = setup.mode === "http" ? createSlackReceiver(input, setup, start) : undefined;
			const bolt = createSlackApp(input, setup, receiver);
			app = bolt;
			botUserId = await slackBotUserId(bolt.client, log);
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
					progress: input.progress,
					streaming: input.streaming,
					messages: start.messages,
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
					messages: start.messages,
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
					messages: start.messages,
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
					messages: start.messages,
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
					text?: string;
					client_msg_id?: string;
					ts?: string;
					thread_ts?: string;
					files?: SlackFile[];
				};
				if (!slackMessageSubtypeAllowed(msg.subtype) || msg.bot_id) return;
				const channel = msg.channel ?? "unknown";
				const team = slackTeam(body) ?? msg.team;
				const mode = input.reply ?? "thread";
				const reply = target(mode, msg);
				const trace = msg.client_msg_id ?? msg.ts;
				const context = (extra?: Record<string, unknown>) => logCtx({ trace, adapter: name, kind, channel }, extra);
				const allow = slackAllowed(input.allow, { team, channel, user: msg.user, isDm: slackDm(msg) });
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
						actor: msg.user,
						event: msg.client_msg_id ?? msg.ts,
					}),
				);
				const progress = slackProgress(input.progress);
				const stream = slackReplyStream({
					config: input.streaming,
					client,
					channel,
					thread: reply.thread,
					approval: undefined,
					logger: log,
					context: context({ thread: reply.thread }),
					delivery,
				});
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
						team,
						channel,
						actor: msg.user ?? "unknown",
						thread: threadKey(input.reply ?? "thread", msg),
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
								replyBroadcast: input.replyBroadcast ?? false,
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
								replyBroadcast: input.replyBroadcast ?? false,
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
							replyBroadcast: input.replyBroadcast ?? false,
							skipFirst: sent,
							logger: log,
							context: context({ thread: reply.thread }),
							delivery,
						});
					},
					afterSend: async (out, visibility) => {
						if (visibility === "public") {
							await uploadSlackAttachments({
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
				replyBroadcast: input.replyBroadcast ?? false,
				logger: log,
				context: { adapter: name, kind, channel, thread: target.thread },
				delivery,
			});
			await uploadSlackAttachments({
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
			log?.debug("adapter.send", { adapter: name, kind, channel, thread: target.thread, chars: out.text.length });
		},
	};
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
	if (input === false) return undefined;
	return input ?? { delayMs: 0 };
}

async function uploadSlackAttachments(input: {
	client: SlackClient;
	store?: AttachmentStore;
	channel: string;
	thread?: string;
	attachments?: Array<{ path: string; name?: string; mimeType?: string }>;
	scope?: ScopedKey;
	logger: Logger;
	context: Record<string, unknown>;
	delivery: DeliveryQueue;
}): Promise<void> {
	if (!input.attachments?.length) return;
	const files = await resolveOutboundAttachments({
		provider: "slack",
		store: input.store,
		attachments: input.attachments,
		scope: input.scope,
		logger: input.logger,
		context: input.context,
	});
	if (!files.length) return;
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
	} catch (error) {
		input.logger.warn("slack.attachment_upload_failed", { ...input.context, error: errorMessage(error) });
	}
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
		const message = {
			channel: input.channel,
			user: input.user,
			text: chunks[index],
			thread_ts: input.thread,
			...(blocks ? { blocks } : {}),
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
}) {
	if (!input.config || (typeof input.config === "object" && input.config.enabled === false)) return undefined;
	return new DraftReplyStream(
		{
			limit: SLACK_TEXT_LIMIT,
			create: async (text) => {
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

function startProgress(input: {
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
	const reaction = input.progress ? (input.progress.reaction ?? "eyes") : false;
	let message = input.progress ? (input.progress.message ?? "Working...") : false;

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
			setTimeout(() => {
				if (!active) {
					resolve();
					return;
				}
				const progressText = message;
				if (progressText === false) {
					resolve();
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
					.finally(resolve);
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
			await placeholderTask;
			if (!placeholder) return false;
			const ts = placeholder;
			placeholder = undefined;
			try {
				const chunks = slackChunks(text, Boolean(approval));
				const first = chunks[0] ?? "";
				const blocks = approvalBlocks(approval);
				await input.delivery.run(
					() =>
						input.client.chat.update(
							blocks
								? { channel: input.channel, ts, text: first, blocks }
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
		async stop(): Promise<void> {
			active = false;
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
			if (reacted && reaction && input.source) {
				const source = input.source;
				reacted = false;
				await input.delivery
					.run(
						() => input.client.reactions.remove({ channel: input.channel, timestamp: source, name: reaction }),
						{
							...input.context,
							delivery: "reaction_remove",
						},
					)
					.catch((error) => {
						input.logger.warn("slack.progress.reaction_remove_failed", {
							...input.context,
							error: errorMessage(error),
						});
					});
			}
		},
	};
}

function target(mode: SlackReply, msg: { channel?: string; ts?: string; thread_ts?: string }) {
	if (mode === "channel") return {};
	if (mode === "same") return { thread: msg.thread_ts };
	if (msg.channel?.startsWith("D")) return {};
	return { thread: msg.thread_ts ?? msg.ts };
}

function threadKey(mode: SlackReply, msg: { channel?: string; ts?: string; thread_ts?: string }) {
	const channel = msg.channel ?? "unknown";
	if (channel.startsWith("D")) return `${channel}:${channel}`;
	if (mode === "thread") return `${channel}:${msg.thread_ts ?? msg.ts ?? channel}`;
	return `${channel}:${channel}`;
}

function shouldReact(mode: SlackReply, msg: { channel?: string; ts?: string; thread_ts?: string }) {
	return mode === "thread" && !msg.channel?.startsWith("D") && !msg.thread_ts && !!msg.ts;
}

export function slackMessageSubtypeAllowed(subtype: string | undefined): boolean {
	return subtype === undefined || subtype === "file_share";
}

async function slackBotUserId(client: SlackClient, logger: Logger): Promise<string | undefined> {
	try {
		const out = (await client.auth.test()) as { user_id?: string };
		return out.user_id;
	} catch (error) {
		logger.warn("slack.auth_test_failed", { adapter: "slack", error: errorMessage(error) });
		return undefined;
	}
}

function slackDm(msg: { channel?: string; channel_type?: string }): boolean {
	return msg.channel_type === "im" || msg.channel?.startsWith("D") === true;
}

export function slackAllowed(
	allow: SlackAllow | undefined,
	event: { team?: string; channel?: string; user?: string; isDm: boolean },
): { ok: true } | { ok: false; reason: string } {
	return allowByDimensions({
		dms: allow?.dms,
		isDm: event.isDm,
		dmReason: "dm_not_allowed",
		dimensions: [
			{ allowlist: allow?.teams, value: event.team, reason: "team_not_allowed" },
			{ allowlist: allow?.channels, value: event.channel, reason: "channel_not_allowed", skip: event.isDm },
			{ allowlist: allow?.users, value: event.user, reason: "user_not_allowed" },
		],
	});
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
type SlackUpdate = { text: string; blocks?: SlackBlock[] };

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

async function handleAction(input: {
	kind: "approve" | "deny" | "cancel" | "status";
	body: unknown;
	action: unknown;
	client: SlackClient;
	handler: Handler;
	logger: Logger;
	delivery: DeliveryQueue;
	provider: string;
	adapterKind: string;
	progress?: SlackConfig["progress"];
	streaming?: ReplyStreamOption;
	messages?: AppMessages;
}): Promise<void> {
	const value = stringProp(record(input.action), "value");
	const context = actionContext(input.body);
	if (!context.channel || !context.actor) return;
	if (!value && input.kind !== "status") return;
	const actionChannel = context.channel;
	const actionActor = context.actor;
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
		if (!update.blocks) throw new Error("Slack approval acknowledgement missing approval blocks");
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
		if (!update.blocks) throw new Error("Slack approval action missing approval blocks");
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
			thread: context.thread,
			text: input.kind === "status" ? "status" : `${input.kind} ${value}`,
			data: input.body,
			stream,
			ack: input.kind === "approve" ? (out) => acknowledge(out) : undefined,
			replace: input.kind === "approve" || input.kind === "deny" ? replace : undefined,
		});
		if (!out) return;
		if (out.private || !context.message) {
			await stream?.clear?.();
			const channel = context.channel;
			const actor = context.actor;
			if (out.replaceOriginal && context.message) {
				const update = slackApprovalUpdate(out, out.approvalResolution, actor, input.body);
				if (update.blocks) {
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
			if (streamed) {
				await progress?.stop();
			} else {
				const sent = await progress?.update(out.text, out.approval);
				await postPublicChunks({
					client: input.client,
					channel,
					text: out.text,
					approval: sent ? undefined : out.approval,
					thread: context.threadTs ?? message,
					skipFirst: sent,
					logger: input.logger,
					context: logContext({ channel, thread: context.threadTs ?? message }),
					delivery: input.delivery,
				});
			}
			input.logger.debug("adapter.send", logContext({ channel: context.channel, update: true }));
			return;
		}
		if (input.kind === "approve") {
			if (streamed) {
				await progress?.stop();
			} else {
				await postPublicChunks({
					client: input.client,
					channel,
					text: out.text,
					approval: out.approval,
					thread: context.threadTs ?? message,
					logger: input.logger,
					context: logContext({ channel, thread: context.threadTs ?? message }),
					delivery: input.delivery,
				});
			}
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
	return blocks ? { text, blocks } : { text };
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
					text: { type: "plain_text", text: "Cancel" },
					style: "danger",
					action_id: CANCEL,
					value: id,
				},
				{
					type: "button",
					text: { type: "plain_text", text: "Status" },
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
	if (blocks) base.blocks = blocks;
	return base as unknown as SlackMessage;
}

export function approvalBlocks(
	approval?: Outbound["approval"],
	state?: Outbound["approvalResolution"],
	actor?: string,
): SlackBlock[] | undefined {
	if (!approval) return undefined;
	const blocks: SlackBlock[] = [
		{ type: "section", text: { type: "mrkdwn", text: approvalTitleText(state) } },
		...(approval.reason ? labeledBlock("Reason", approval.reason) : []),
		...(approval.details ?? []).flatMap((detail) =>
			labeledBlock(detail.label, detail.format === "code" ? codeFence(detail.value) : detail.value),
		),
		...(approval.requestedBy ? contextBlock(`Requested by <@${approval.requestedBy}>`) : []),
		...(state
			? contextBlock(approvalResolutionText(state, actor))
			: [
					{
						type: "actions",
						elements: [
							{
								type: "button",
								text: { type: "plain_text", text: "Approve" },
								style: "primary",
								action_id: APPROVE,
								value: approval.id,
							},
							{
								type: "button",
								text: { type: "plain_text", text: "Reject" },
								style: "danger",
								action_id: DENY,
								value: approval.id,
							},
						],
					} satisfies SlackBlock,
				]),
	];
	return blocks;
}

function approvalBlocksFromPayload(body: unknown): SlackBlock[] | undefined {
	const message = record(record(body)?.message);
	const blocks = message?.blocks;
	if (!Array.isArray(blocks)) return undefined;
	return blocks.map((block) => stripSlackBlockId(block as SlackBlock));
}

function resolveApprovalBlocks(
	blocks: SlackBlock[],
	resolution: { title?: string; status: string },
): SlackBlock[] | undefined {
	const actions = approvalActionsIndex(blocks);
	if (actions < 0) return undefined;
	const next = [...blocks];
	if (resolution.title) {
		const title = approvalTitleIndex(next);
		if (title >= 0) next[title] = { type: "section", text: { type: "mrkdwn", text: resolution.title } };
	}
	next[actions] = contextBlock(resolution.status)[0];
	return next;
}

function approvalActionsIndex(blocks: SlackBlock[]): number {
	for (let i = blocks.length - 1; i >= 0; i--) {
		if (isApprovalActionsBlock(blocks[i])) return i;
	}
	return -1;
}

function approvalTitleIndex(blocks: SlackBlock[]): number {
	for (const [index, block] of blocks.entries()) {
		const value = record(block);
		const text = stringProp(record(value?.text), "text");
		if (text?.startsWith("*Approval ")) return index;
	}
	return -1;
}

function isApprovalActionsBlock(block: SlackBlock): boolean {
	const value = record(block);
	if (value?.type !== "actions" || !Array.isArray(value.elements)) return false;
	return value.elements.some((element) => {
		const actionId = stringProp(record(element), "action_id");
		return actionId === APPROVE || actionId === DENY;
	});
}

function stripSlackBlockId(block: SlackBlock): SlackBlock {
	const value = { ...(block as unknown as Record<string, unknown>) };
	delete value.block_id;
	return value as unknown as SlackBlock;
}

function approvalTitleText(state?: Outbound["approvalResolution"]): string {
	return `*${approvalStateTitle(state)}*`;
}

function labeledBlock(label: string, value: string): SlackBlock[] {
	return [{ type: "section", text: { type: "mrkdwn", text: `*${label}*\n${value}` } }];
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
