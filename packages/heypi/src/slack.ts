import { App } from "@slack/bolt";
import type { KnownBlock } from "@slack/types";
import { approvalActorAllowed, approvalRows, approvalTitle, renderApprovalMessage } from "./approval.js";
import { materializeAttachments } from "./attachments.js";
import { type AdapterEvents, busyEvents, statusEvents } from "./events.js";
import { chunkText, formatOutgoingText, splitLocalAttachments } from "./message.js";
import type {
	Adapter,
	AdapterApprovalConfig,
	AdapterContext,
	AllowConfig,
	ApprovalDecision,
	ApprovalView,
	ApproverSet,
	BusyMode,
	ChatMessage,
} from "./types.js";

const APPROVE = "heypi_approve";
const REJECT = "heypi_reject";

export type SlackConfig = {
	id?: string;
	token: string;
	appToken: string;
	allow?: AllowConfig;
	admins?: ApproverSet;
	approvers?: ApproverSet;
	approvals?: AdapterApprovalConfig;
	busy?: BusyMode;
	progress?: boolean;
	events?: AdapterEvents;
};

type SlackEvent = {
	ts?: string;
	thread_ts?: string;
	channel?: string;
	channel_type?: string;
	user?: string;
	bot_id?: string;
	app_id?: string;
	subtype?: string;
	username?: string;
	text?: string;
	files?: Array<{ id?: string; name?: string; url_private?: string; mimetype?: string }>;
};

type PendingApproval = {
	channel: string;
	message: string;
	view: ApprovalView;
	timer?: ReturnType<typeof setTimeout>;
	resolve(decision: ApprovalDecision): void;
};

type SlackApprovalPayload = {
	text: string;
	blocks?: KnownBlock[];
	attachments?: Array<{ color: string; fallback: string; blocks: KnownBlock[] }>;
};

const HUMAN_MESSAGE_SUBTYPES = new Set(["file_share", "me_message", "thread_broadcast"]);
const SLACK_TEXT_LIMIT = 39_000;

export type SlackBotIdentity = {
	botId?: string;
	appId?: string;
	userId?: string;
};

export function slackMessage(
	event: SlackEvent,
	mentioned: boolean,
	self: SlackBotIdentity = {},
	account = "slack",
): ChatMessage {
	const conversation = event.channel ?? "unknown";
	const bot = slackBotSender(event, self);
	const isSelf = botIdentityMatches(bot, self);
	return {
		id: event.ts ?? `slack-${Date.now()}`,
		adapter: "slack",
		account,
		conversation,
		thread: event.channel_type === "im" ? undefined : (event.thread_ts ?? event.ts),
		...(event.thread_ts ? { reply: true } : {}),
		user: {
			id: event.user ?? event.bot_id ?? event.app_id ?? "unknown",
			name: event.username,
			isBot: Boolean(bot),
			...(isSelf ? { isSelf: true } : {}),
		},
		text: event.text ?? "",
		mentioned,
		dm: event.channel_type === "im",
		attachments: event.files?.map((file) => ({
			id: file.id,
			name: file.name,
			url: file.url_private,
			mime: file.mimetype,
		})),
	};
}

export function slack(config: SlackConfig): Adapter {
	let app: App | undefined;
	let context: AdapterContext | undefined;
	let self: SlackBotIdentity = {};
	const pending = new Map<string, PendingApproval>();
	const id = config.id ?? "slack";

	return {
		kind: "slack",
		id,
		allow: config.allow,
		admins: config.admins,
		approvers: config.approvers,
		approvals: config.approvals,
		busy: config.busy ?? "queue",
		progress: config.progress ?? true,
		events: progressEvents(config.progress, config.events),
		async start(nextContext) {
			context = nextContext;
			app = new App({ appToken: config.appToken, socketMode: true, token: config.token });
			self = await slackBotIdentity(app, context.logger);
			app.event("app_mention", async ({ event }) => {
				if (!slackMessageEventAllowed(event as SlackEvent)) return;
				const normalized = slackMessage(event as SlackEvent, true, self, id);
				if (normalized.user.isSelf) return;
				await context?.receive(normalized);
			});
			app.message(async ({ message }) => {
				const event = message as SlackEvent;
				if (!slackMessageEventAllowed(event)) return;
				if (event.channel_type !== "im" && !event.thread_ts) return;
				const normalized = slackMessage(event, false, self, id);
				if (normalized.user.isSelf) return;
				await context?.receive(normalized);
			});
			app.action(APPROVE, async ({ ack, body }) => {
				await ack();
				const id = actionValue(body);
				const approval = id ? pending.get(id) : undefined;
				if (!id || !approval) return;
				const resolvedBy = bodyUser(body);
				const resolvedById = bodyUserId(body);
				if (!approvalActorAllowed({ approved: true, resolvedBy, resolvedById }, config.approvers, config.admins))
					return;
				pending.delete(id);
				if (approval.timer) clearTimeout(approval.timer);
				await app?.client.chat.update({
					channel: approval.channel,
					ts: approval.message,
					...slackApprovalPayload({ ...approval.view, state: "approved", resolvedBy }),
				});
				approval.resolve({ approved: true, resolvedBy, resolvedById });
			});
			app.action(REJECT, async ({ ack, body }) => {
				await ack();
				const id = actionValue(body);
				const approval = id ? pending.get(id) : undefined;
				if (!id || !approval) return;
				const resolvedBy = bodyUser(body);
				const resolvedById = bodyUserId(body);
				if (!approvalActorAllowed({ approved: false, resolvedBy, resolvedById }, config.approvers, config.admins))
					return;
				pending.delete(id);
				if (approval.timer) clearTimeout(approval.timer);
				await app?.client.chat.update({
					channel: approval.channel,
					ts: approval.message,
					...slackApprovalPayload({ ...approval.view, state: "rejected", resolvedBy }),
				});
				approval.resolve({
					approved: false,
					resolvedBy,
					resolvedById,
					reason: "Rejected in Slack.",
				});
			});
			await app.start();
			context.logger.info("adapter.slack.start", { mode: "socket" });
		},
		async stop() {
			await app?.stop();
			app = undefined;
		},
		async react(message, emoji) {
			if (!app) throw new Error("Slack adapter is not started");
			await app.client.reactions.add({
				channel: message.conversation,
				name: emoji,
				timestamp: message.id,
			});
		},
		async materializeAttachments(message, target) {
			return {
				...message,
				attachments: await materializeAttachments(message.attachments, {
					dir: target.dir,
					displayDir: target.displayDir,
					headers: { authorization: `Bearer ${config.token}` },
				}),
			};
		},
		async send(message) {
			if (!app) throw new Error("Slack adapter is not started");
			const { local, references } = splitLocalAttachments(message.attachments);
			if (local.length > 0) {
				const comment = formatOutgoingText(message.text, references);
				const chunks = chunkText(comment, SLACK_TEXT_LIMIT);
				for (const chunk of chunks.slice(0, -1)) {
					await app.client.chat.postMessage({
						channel: message.conversation,
						thread_ts: message.thread,
						text: chunk,
					});
				}
				await app.client.filesUploadV2({
					channel_id: message.conversation,
					thread_ts: message.thread,
					initial_comment: chunks.at(-1) ?? "",
					file_uploads: local.map((attachment) => ({
						file: attachment.localPath ?? "",
						filename: attachment.name,
						title: attachment.name,
					})),
				});
				return undefined;
			}
			let firstId: string | undefined;
			for (const text of chunkText(formatOutgoingText(message.text, message.attachments), SLACK_TEXT_LIMIT)) {
				const result = await app.client.chat.postMessage({
					channel: message.conversation,
					thread_ts: message.thread,
					text,
				});
				firstId ??= result.ts;
			}
			return { id: firstId };
		},
		async update(message) {
			if (!app) throw new Error("Slack adapter is not started");
			await app.client.chat.update({
				channel: message.conversation,
				ts: message.id,
				text: formatOutgoingText(message.text, message.attachments),
			});
		},
		async remove(message) {
			if (!app) throw new Error("Slack adapter is not started");
			await app.client.chat.delete({ channel: message.conversation, ts: message.id });
		},
		async requestApproval(view) {
			if (!app) return { approved: false, reason: "Slack adapter is not started." };
			if (!view.conversation) return { approved: false, reason: "Slack approval has no target conversation." };
			const result = await app.client.chat.postMessage({
				channel: view.conversation,
				thread_ts: view.thread,
				...slackApprovalPayload(view),
			});
			return new Promise<ApprovalDecision>((resolve) => {
				const pendingApproval: PendingApproval = {
					channel: view.conversation ?? "",
					message: result.ts ?? "",
					view,
					resolve,
				};
				const timeoutMs = config.approvals?.timeoutMs;
				if (timeoutMs && timeoutMs > 0) {
					pendingApproval.timer = setTimeout(() => {
						if (!pending.delete(view.id)) return;
						void app?.client.chat
							.update({
								channel: pendingApproval.channel,
								ts: pendingApproval.message,
								...slackApprovalPayload({ ...view, state: "rejected", resolvedBy: "timeout" }),
							})
							.catch(() => undefined);
						resolve({ approved: false, reason: "Approval expired." });
					}, timeoutMs);
				}
				pending.set(view.id, pendingApproval);
			});
		},
	};
}

function progressEvents(progress: boolean | undefined, events: AdapterEvents | undefined): AdapterEvents | undefined {
	if (progress === false) return { ...busyEvents(), ...(events ?? {}) };
	return { ...statusEvents(), ...(events ?? {}) };
}

async function slackBotIdentity(app: App, logger: AdapterContext["logger"]): Promise<SlackBotIdentity> {
	try {
		const result = (await app.client.auth.test()) as { bot_id?: string; app_id?: string; user_id?: string };
		return { botId: result.bot_id, appId: result.app_id, userId: result.user_id };
	} catch (error) {
		logger.warn("slack.auth_test_failed", { message: error instanceof Error ? error.message : String(error) });
		return {};
	}
}

function slackBotSender(event: SlackEvent, self: SlackBotIdentity): SlackBotIdentity | undefined {
	if (event.user && event.user === self.userId) return { userId: event.user };
	if (event.bot_id || event.app_id || !event.user) {
		return { botId: event.bot_id, appId: event.app_id, userId: event.user };
	}
	return undefined;
}

export function slackMessageEventAllowed(event: SlackEvent): boolean {
	if (event.bot_id || event.app_id) return event.subtype === undefined || event.subtype === "bot_message";
	if (!event.user) return false;
	if (!event.subtype) return true;
	return HUMAN_MESSAGE_SUBTYPES.has(event.subtype);
}

function botIdentityMatches(bot: SlackBotIdentity | undefined, self: SlackBotIdentity): boolean {
	if (!bot) return false;
	const botIds = [bot.botId, bot.appId, bot.userId].filter((id): id is string => Boolean(id));
	const selfIds = [self.botId, self.appId, self.userId].filter((id): id is string => Boolean(id));
	return botIds.some((id) => selfIds.includes(id));
}

export function slackApprovalPayload(view: ApprovalView): SlackApprovalPayload {
	const actions = approvalActions(view);
	if (view.layout === "card") {
		const blocks = slackApprovalCardBlocks(view);
		return {
			text: "",
			attachments: [{ color: approvalColor(view.state), fallback: renderApprovalMessage(view), blocks }],
			blocks: view.state ? [] : [actions],
		};
	}
	return {
		text: renderApprovalMessage(view),
		blocks: view.state
			? [{ type: "section", text: { type: "mrkdwn", text: renderApprovalMessage(view) } }]
			: [{ type: "section", text: { type: "mrkdwn", text: renderApprovalMessage(view) } }, actions],
	};
}

function slackApprovalCardBlocks(view: ApprovalView): KnownBlock[] {
	return [
		{ type: "section", text: { type: "mrkdwn", text: `*${approvalTitle(view.state)}*` } },
		...approvalRows(view).map((row): KnownBlock => {
			const value = row.format === "code" ? `\`\`\`\n${row.value}\n\`\`\`` : row.value;
			return { type: "section", text: { type: "mrkdwn", text: `*${row.label}*\n${value}` } };
		}),
	];
}

function approvalActions(view: ApprovalView): KnownBlock {
	return {
		type: "actions",
		elements: [
			{
				type: "button",
				text: { type: "plain_text", text: "Approve" },
				style: "primary",
				value: view.id,
				action_id: APPROVE,
			},
			{
				type: "button",
				text: { type: "plain_text", text: "Reject" },
				style: "danger",
				value: view.id,
				action_id: REJECT,
			},
		],
	};
}

function approvalColor(state?: ApprovalView["state"]): string {
	if (state === "approved") return "#2EB67D";
	if (state === "rejected") return "#E01E5A";
	return "#ECB22E";
}

function actionValue(body: unknown): string | undefined {
	const actions =
		body && typeof body === "object" && "actions" in body ? (body as { actions?: unknown }).actions : undefined;
	if (!Array.isArray(actions)) return undefined;
	const action = actions[0];
	if (!action || typeof action !== "object" || !("value" in action)) return undefined;
	return typeof action.value === "string" ? action.value : undefined;
}

function bodyUser(body: unknown): string | undefined {
	const id = bodyUserId(body);
	return id ? `<@${id}>` : undefined;
}

function bodyUserId(body: unknown): string | undefined {
	const user = body && typeof body === "object" && "user" in body ? (body as { user?: unknown }).user : undefined;
	if (!user || typeof user !== "object" || !("id" in user)) return undefined;
	return typeof user.id === "string" ? user.id : undefined;
}
