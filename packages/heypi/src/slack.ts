import { App } from "@slack/bolt";
import type { KnownBlock } from "@slack/types";
import { renderApprovalMessage } from "./approval.js";
import type { Adapter, AdapterContext, ApprovalDecision, ApprovalView, ChatMessage } from "./types.js";

const APPROVE = "heypi_approve";
const REJECT = "heypi_reject";

export type SlackConfig = {
	name?: string;
	token: string;
	appToken: string;
	reaction?: string | false;
};

type SlackEvent = {
	ts?: string;
	channel?: string;
	channel_type?: string;
	user?: string;
	username?: string;
	text?: string;
	files?: Array<{ id?: string; name?: string; url_private?: string; mimetype?: string }>;
};

type PendingApproval = {
	resolve(decision: ApprovalDecision): void;
};

export function slackMessage(event: SlackEvent, mentioned: boolean): ChatMessage {
	const conversation = event.channel ?? "unknown";
	return {
		id: event.ts ?? `slack-${Date.now()}`,
		adapter: "slack",
		account: "slack",
		conversation,
		user: {
			id: event.user ?? "unknown",
			name: event.username,
			isBot: false,
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
	const pending = new Map<string, PendingApproval>();
	const reaction = config.reaction === undefined ? "eyes" : config.reaction;

	return {
		kind: "slack",
		name: config.name,
		async start(nextContext) {
			context = nextContext;
			app = new App({ appToken: config.appToken, socketMode: true, token: config.token });
			app.event("app_mention", async ({ event }) => {
				await context?.receive(slackMessage(event as SlackEvent, true));
			});
			app.message(async ({ message }) => {
				const event = message as SlackEvent;
				if (event.channel_type !== "im") return;
				await context?.receive(slackMessage(event, false));
			});
			app.action(APPROVE, async ({ ack, body }) => {
				await ack();
				const id = actionValue(body);
				const approval = id ? pending.get(id) : undefined;
				if (!id || !approval) return;
				pending.delete(id);
				approval.resolve({ approved: true, resolvedBy: bodyUser(body) });
			});
			app.action(REJECT, async ({ ack, body }) => {
				await ack();
				const id = actionValue(body);
				const approval = id ? pending.get(id) : undefined;
				if (!id || !approval) return;
				pending.delete(id);
				approval.resolve({ approved: false, resolvedBy: bodyUser(body), reason: "Rejected in Slack." });
			});
			await app.start();
			context.logger.info("adapter.slack.start", { mode: "socket" });
		},
		async stop() {
			await app?.stop();
			app = undefined;
		},
		async ack(message) {
			if (!app || !reaction) return;
			await app.client.reactions.add({
				channel: message.conversation,
				name: reaction,
				timestamp: message.id,
			});
		},
		async send(message) {
			if (!app) throw new Error("Slack adapter is not started");
			const result = await app.client.chat.postMessage({
				channel: message.conversation,
				thread_ts: message.thread,
				text: message.text,
			});
			return { id: result.ts };
		},
		async requestApproval(view) {
			if (!app) return { approved: false, reason: "Slack adapter is not started." };
			if (!view.conversation) return { approved: false, reason: "Slack approval has no target conversation." };
			await app.client.chat.postMessage({
				channel: view.conversation,
				thread_ts: view.thread,
				text: renderApprovalMessage(view),
				blocks: approvalBlocks(view),
			});
			return new Promise<ApprovalDecision>((resolve) => {
				pending.set(view.id, { resolve });
			});
		},
	};
}

function approvalBlocks(view: ApprovalView): KnownBlock[] {
	return [
		{ type: "section", text: { type: "mrkdwn", text: renderApprovalMessage(view) } },
		{
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
		},
	];
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
	const user = body && typeof body === "object" && "user" in body ? (body as { user?: unknown }).user : undefined;
	if (!user || typeof user !== "object" || !("id" in user)) return undefined;
	return typeof user.id === "string" ? `<@${user.id}>` : undefined;
}
