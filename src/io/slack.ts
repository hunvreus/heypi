import { type AllMiddlewareArgs, App, type types } from "@slack/bolt";
import { message as errorMessage, type Logger, userError } from "../core/log.js";
import { chunkText } from "../render/chunk.js";
import type { Attachment, AttachmentStore, ResolvedAttachment } from "./attachments.js";
import type { Adapter, AdapterStart, Handler } from "./handler.js";

const APPROVE = "heypi_approve";
const DENY = "heypi_deny";
const CANCEL = "heypi_cancel";
const STATUS = "heypi_status";
const SLACK_TEXT_LIMIT = 4000;
const SLACK_BLOCK_TEXT_LIMIT = 3000;

export type SlackConfig = {
	botToken: string;
	signingSecret: string;
	reply?: SlackReply;
	replyBroadcast?: boolean;
	progress?: SlackProgress | false;
} & (SlackSocketConfig | SlackHttpConfig);

export type SlackSocketConfig = {
	mode?: "socket";
	appToken: string;
};

export type SlackHttpConfig = {
	mode: "http";
	port?: number | string;
	path?: string | string[];
};

export type SlackReply = "thread" | "same" | "channel";

export type SlackProgress = {
	reaction?: string | false;
	message?: string | false;
	delayMs?: number;
};

/** Creates the Slack adapter using Socket Mode or Slack's HTTP receiver. */
export function slack(input: SlackConfig): Adapter {
	const setup = slackSetup(input);
	const app = new App({
		token: input.botToken,
		signingSecret: input.signingSecret,
		socketMode: setup.mode === "socket",
		appToken: setup.appToken,
		endpoints: setup.endpoints,
	});
	let activeLogger: Logger | undefined;

	return {
		async start(start: AdapterStart): Promise<void> {
			const { handler, logger: log } = start;
			activeLogger = log;
			log.info("adapter.start", { adapter: "slack", mode: setup.mode });
			app.action(APPROVE, async ({ ack, body, action, client }) => {
				await ack();
				await handleAction({ kind: "approve", body, action, client, handler, logger: log });
			});
			app.action(DENY, async ({ ack, body, action, client }) => {
				await ack();
				await handleAction({ kind: "deny", body, action, client, handler, logger: log });
			});
			app.action(CANCEL, async ({ ack, body, action, client }) => {
				await ack();
				await handleAction({ kind: "cancel", body, action, client, handler, logger: log });
			});
			app.action(STATUS, async ({ ack, body, action, client }) => {
				await ack();
				await handleAction({ kind: "status", body, action, client, handler, logger: log });
			});
			app.message(async ({ event, client }) => {
				const msg = event as {
					subtype?: string;
					bot_id?: string;
					channel?: string;
					user?: string;
					text?: string;
					client_msg_id?: string;
					ts?: string;
					thread_ts?: string;
					files?: SlackFile[];
				};
				if (msg.subtype || msg.bot_id) return;
				const channel = msg.channel ?? "unknown";
				const mode = input.reply ?? "thread";
				const reply = target(mode, msg);
				const trace = msg.client_msg_id ?? msg.ts;
				log.debug("adapter.receive", {
					trace,
					adapter: "slack",
					channel,
					thread: msg.thread_ts,
					actor: msg.user,
					event: msg.client_msg_id ?? msg.ts,
				});
				const progress = input.progress === false ? undefined : input.progress;
				const pending = startProgress({
					channel,
					source: shouldReact(mode, msg) ? msg.ts : undefined,
					target: reply.thread,
					client,
					progress,
					cancelId: trace,
					logger: log,
					context: { trace, adapter: "slack", channel, thread: msg.thread_ts ?? reply.thread, event: msg.ts },
				});
				try {
					const attachments = await slackAttachments({
						store: start.attachments,
						files: msg.files,
						token: input.botToken,
						messageId: msg.ts,
						trace,
						logger: log,
					});
					const out = await handler({
						trace,
						provider: "slack",
						eventId: msg.client_msg_id ?? msg.ts,
						channel,
						actor: msg.user ?? "unknown",
						thread: threadKey(input.reply ?? "thread", msg),
						text: msg.text ?? "",
						attachments,
						data: { channel: msg.channel, ts: msg.ts, thread_ts: msg.thread_ts, files: msg.files },
					});
					if (out) {
						if (out.private) {
							await postEphemeralChunks({
								client,
								channel,
								user: msg.user ?? "unknown",
								text: out.text,
								approval: out.approval,
							});
							if (out.attachments?.length) {
								await postEphemeralChunks({
									client,
									channel,
									user: msg.user ?? "unknown",
									text: "File attachments cannot be sent privately on Slack.",
								});
							}
							log.debug("adapter.send", {
								trace,
								adapter: "slack",
								channel,
								private: true,
								chars: out.text.length,
							});
						} else {
							const sent = await pending.update(out.text, out.approval);
							await postPublicChunks({
								client,
								channel,
								text: out.text,
								approval: sent ? undefined : out.approval,
								thread: reply.thread,
								replyBroadcast: input.replyBroadcast ?? false,
								skipFirst: sent,
							});
							await uploadSlackAttachments({
								client,
								store: start.attachments,
								channel,
								thread: reply.thread,
								attachments: out.attachments,
								logger: log,
								context: { trace, adapter: "slack", channel, thread: reply.thread },
							});
							log.debug("adapter.send", {
								trace,
								adapter: "slack",
								channel,
								thread: reply.thread,
								chars: out.text.length,
							});
						}
					}
				} catch (error) {
					log.error("adapter.error", {
						trace,
						adapter: "slack",
						channel,
						thread: reply.thread,
						error: errorMessage(error),
					});
					const text = userError("handler");
					const sent = await pending.update(text);
					await postPublicChunks({
						client,
						channel,
						text,
						thread: reply.thread,
						replyBroadcast: input.replyBroadcast ?? false,
						skipFirst: sent,
					});
				} finally {
					await pending.stop();
				}
			});
			if (setup.mode === "http") await app.start(setup.port);
			else await app.start();
		},
		async stop(): Promise<void> {
			await app.stop();
			activeLogger?.info("adapter.stop", { adapter: "slack", mode: setup.mode });
		},
	};
}

function slackSetup(
	input: SlackConfig,
):
	| { mode: "socket"; appToken: string; endpoints?: undefined; port?: undefined }
	| { mode: "http"; appToken?: undefined; endpoints: string | string[]; port: number | string } {
	if (input.mode === "http") {
		return { mode: "http", endpoints: input.path ?? "/slack/events", port: input.port ?? 3000 };
	}
	return { mode: "socket", appToken: input.appToken };
}

async function uploadSlackAttachments(input: {
	client: SlackClient;
	store?: AttachmentStore;
	channel: string;
	thread?: string;
	attachments?: Array<{ path: string; name?: string; mimeType?: string }>;
	logger: Logger;
	context: Record<string, unknown>;
}): Promise<void> {
	if (!input.attachments?.length) return;
	if (!input.store) {
		input.logger.warn("slack.attachments_missing_store", input.context);
		return;
	}
	const files: ResolvedAttachment[] = [];
	for (const attachment of input.attachments) {
		try {
			files.push(await input.store.resolve(attachment));
		} catch (error) {
			input.logger.warn("slack.attachment_resolve_failed", {
				...input.context,
				path: attachment.path,
				error: errorMessage(error),
			});
		}
	}
	if (!files.length) return;
	try {
		await input.client.files.uploadV2({
			channel_id: input.channel,
			thread_ts: input.thread,
			file_uploads: files.map((file) => ({
				file: file.path,
				filename: file.name,
				title: file.name,
			})),
		});
	} catch (error) {
		input.logger.warn("slack.attachment_upload_failed", { ...input.context, error: errorMessage(error) });
	}
}

async function postPublicChunks(input: {
	client: SlackClient;
	channel: string;
	text: string;
	approval?: { id: string; callId: string; reason: string; command: string };
	thread?: string;
	replyBroadcast?: boolean;
	skipFirst?: boolean;
}): Promise<void> {
	const chunks = slackChunks(input.text, Boolean(input.approval));
	for (let index = input.skipFirst ? 1 : 0; index < chunks.length; index++) {
		await input.client.chat.postMessage(
			slackMessage({
				channel: input.channel,
				text: chunks[index],
				approval: index === 0 ? input.approval : undefined,
				thread: input.thread,
				replyBroadcast: input.replyBroadcast ?? false,
			}),
		);
	}
}

async function postEphemeralChunks(input: {
	client: SlackClient;
	channel: string;
	user: string;
	text: string;
	approval?: { id: string; callId: string; reason: string; command: string };
}): Promise<void> {
	const chunks = slackChunks(input.text, Boolean(input.approval));
	for (let index = 0; index < chunks.length; index++) {
		const blocks = index === 0 ? approvalBlocks(chunks[index], input.approval) : undefined;
		await input.client.chat.postEphemeral(
			blocks
				? { channel: input.channel, user: input.user, text: chunks[index], blocks }
				: { channel: input.channel, user: input.user, text: chunks[index] },
		);
	}
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
}) {
	let active = true;
	let reacted = false;
	let placeholder: string | undefined;
	let placeholderTask: Promise<void> | undefined;
	const reaction = input.progress ? (input.progress.reaction ?? "eyes") : false;
	const message = input.progress ? (input.progress.message ?? "Thinking...") : false;

	if (reaction && input.target && input.source) {
		input.client.reactions
			.add({ channel: input.channel, timestamp: input.source, name: reaction })
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
				input.client.chat
					.postMessage({
						channel: input.channel,
						text: message,
						thread_ts: input.target,
						blocks: input.cancelId ? cancelBlocks(message, input.cancelId) : undefined,
					})
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
		async update(
			text: string,
			approval?: { id: string; callId: string; reason: string; command: string },
		): Promise<boolean> {
			active = false;
			await placeholderTask;
			if (!placeholder) return false;
			const ts = placeholder;
			placeholder = undefined;
			try {
				const chunks = slackChunks(text, Boolean(approval));
				const first = chunks[0] ?? "";
				const blocks = approvalBlocks(first, approval);
				await input.client.chat.update(
					blocks
						? { channel: input.channel, ts, text: first, blocks }
						: { channel: input.channel, ts, text: first },
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
				await input.client.chat.delete({ channel: input.channel, ts: placeholder }).catch((error) => {
					input.logger.warn("slack.progress.delete_failed", { ...input.context, error: errorMessage(error) });
				});
			}
			if (reacted && reaction && input.source) {
				await input.client.reactions
					.remove({ channel: input.channel, timestamp: input.source, name: reaction })
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

type SlackClient = AllMiddlewareArgs["client"];
type SlackMessage = Parameters<SlackClient["chat"]["postMessage"]>[0];
type SlackBlock = types.Block | types.KnownBlock;

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
	token: string;
	messageId?: string;
	trace?: string;
	logger: Logger;
}): Promise<Attachment[] | undefined> {
	if (!input.store || !input.files?.length) return undefined;
	const attachments: Attachment[] = [];
	for (const file of input.files) {
		const url = file.url_private_download ?? file.url_private;
		if (!url) continue;
		try {
			const response = await fetch(url, { headers: { Authorization: `Bearer ${input.token}` } });
			if (!response.ok) throw new Error(`Slack file download failed: ${response.status}`);
			const data = new Uint8Array(await response.arrayBuffer());
			attachments.push(
				await input.store.save({
					provider: "slack",
					id: file.id,
					name: file.name ?? file.title ?? file.id ?? "attachment",
					data,
					mimeType: file.mimetype,
					sourceUrl: url,
					messageId: input.messageId,
				}),
			);
		} catch (error) {
			input.logger.warn("slack.attachment_failed", {
				trace: input.trace,
				adapter: "slack",
				file: file.id ?? file.name,
				error: errorMessage(error),
			});
		}
	}
	return attachments.length ? attachments : undefined;
}

async function handleAction(input: {
	kind: "approve" | "deny" | "cancel" | "status";
	body: unknown;
	action: unknown;
	client: SlackClient;
	handler: Handler;
	logger: Logger;
}): Promise<void> {
	const value = stringProp(record(input.action), "value");
	const context = actionContext(input.body);
	if (!context.channel || !context.actor) return;
	if (!value && input.kind !== "status") return;
	const trace = `${input.kind}:${value ?? context.message ?? context.trigger ?? Date.now()}`;
	try {
		const out = await input.handler({
			trace,
			provider: "slack",
			eventId: trace,
			channel: context.channel,
			actor: context.actor,
			thread: context.thread,
			text: input.kind === "status" ? "status" : `${input.kind} ${value}`,
			data: input.body,
		});
		if (!out) return;
		if (out.private || !context.message) {
			await input.client.chat.postEphemeral({ channel: context.channel, user: context.actor, text: out.text });
			input.logger.debug("adapter.send", { trace, adapter: "slack", channel: context.channel, private: true });
			return;
		}
		await input.client.chat.update({
			channel: context.channel,
			ts: context.message,
			text: out.text,
			blocks: [{ type: "section", text: { type: "mrkdwn", text: out.text } }],
		});
		input.logger.debug("adapter.send", { trace, adapter: "slack", channel: context.channel, update: true });
	} catch (error) {
		input.logger.error("adapter.error", {
			trace,
			adapter: "slack",
			channel: context.channel,
			actor: context.actor,
			error: errorMessage(error),
		});
		if (context.message) {
			await input.client.chat
				.update({
					channel: context.channel,
					ts: context.message,
					text: userError("handler"),
					blocks: [{ type: "section", text: { type: "mrkdwn", text: userError("handler") } }],
				})
				.catch(() => undefined);
		}
	}
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
	approval?: { id: string; callId: string; reason: string; command: string };
	thread?: string;
	replyBroadcast?: boolean;
}): SlackMessage {
	const blocks = approvalBlocks(input.text, input.approval);
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

function approvalBlocks(
	text: string,
	approval?: { id: string; callId: string; reason: string; command: string },
): SlackBlock[] | undefined {
	if (!approval) return undefined;
	return [
		{ type: "section", text: { type: "mrkdwn", text } },
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
					text: { type: "plain_text", text: "Deny" },
					style: "danger",
					action_id: DENY,
					value: approval.id,
				},
			],
		},
	];
}

function actionContext(body: unknown) {
	const root = record(body);
	const channel = stringProp(record(root?.channel), "id");
	const actor = stringProp(record(root?.user), "id");
	const message = record(root?.message);
	const messageTs = stringProp(message, "ts");
	const threadTs = stringProp(message, "thread_ts");
	const trigger = stringProp(root, "trigger_id");
	return {
		channel,
		actor,
		message: messageTs,
		trigger,
		thread: channel ? `${channel}:${threadTs ?? messageTs ?? channel}` : "unknown",
	};
}

function record(value: unknown): Record<string, unknown> | undefined {
	return value && typeof value === "object" ? (value as Record<string, unknown>) : undefined;
}

function stringProp(input: Record<string, unknown> | undefined, key: string): string | undefined {
	const value = input?.[key];
	return typeof value === "string" ? value : undefined;
}
