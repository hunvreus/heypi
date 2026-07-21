import { describe, expect, it, vi } from "vitest";
import type { AdapterEvent, AdapterEventContext, AdapterEventHandler, AdapterEvents } from "../src/events.js";
import {
	createSlackActivity,
	slackApprovalPayload,
	slackMessage,
	slackMessageEventAllowed,
	slackMessageMentionsBot,
} from "../src/slack.js";

async function emit(events: AdapterEvents, event: AdapterEvent, context: AdapterEventContext): Promise<void> {
	const handler = events[event.type] as AdapterEventHandler | false | undefined;
	if (!handler) throw new Error(`Missing handler: ${event.type}`);
	await handler(event, context);
}

function activityContext(): AdapterEventContext {
	return {
		message: {
			id: "123.456",
			adapter: "slack",
			adapterId: "slack",
			conversation: "C1",
			thread: "100.000",
			user: { id: "U1" },
			text: "work",
			mentioned: true,
			dm: false,
		},
		send: vi.fn().mockResolvedValue({ id: "reply" }),
		todo: { replace: vi.fn().mockResolvedValue(undefined) },
	};
}

describe("Slack activity", () => {
	it("includes native loading messages", async () => {
		const requests: unknown[] = [];
		const reactions: string[] = [];
		const activity = createSlackActivity(
			true,
			"eyes",
			async (_message, emoji) => {
				reactions.push(emoji);
			},
			async (payload) => {
				requests.push(payload);
			},
		);
		const context = activityContext();

		await emit(activity.events, { type: "message_accepted", origin: "heypi", message: context.message }, context);

		expect(requests).toEqual([
			{
				channel_id: "C1",
				thread_ts: "100.000",
				status: "Thinking...",
				loading_messages: ["Thinking..."],
			},
		]);
		expect(reactions).toEqual(["eyes"]);
	});

	it("clears native status when intake fails", async () => {
		const statuses: string[] = [];
		const activity = createSlackActivity(
			true,
			undefined,
			async () => {},
			async ({ status }) => {
				statuses.push(status);
			},
		);
		const context = activityContext();

		await emit(activity.events, { type: "message_accepted", origin: "heypi", message: context.message }, context);
		await emit(
			activity.events,
			{ type: "message_failed", origin: "heypi", message: context.message, error: "download failed" },
			context,
		);

		expect(statuses).toEqual(["Thinking...", ""]);
	});

	it("lets custom lifecycle hooks replace native status", async () => {
		const order: string[] = [];
		const activity = createSlackActivity(
			true,
			undefined,
			async () => {},
			async () => {
				order.push("status");
			},
			{
				message_accepted: () => {
					order.push("custom");
				},
			},
		);
		const context = activityContext();

		await emit(activity.events, { type: "message_accepted", origin: "heypi", message: context.message }, context);

		expect(order).toEqual(["custom"]);
	});

	it("disables status without disabling reactions or todo rendering", async () => {
		const reactions: string[] = [];
		const requests: unknown[] = [];
		const activity = createSlackActivity(
			false,
			"eyes",
			async (_message, emoji) => {
				reactions.push(emoji);
			},
			async (payload) => {
				requests.push(payload);
			},
		);
		const context = activityContext();
		const job = {
			id: "job",
			state: "running" as const,
			conversation: "C1",
			thread: "100.000",
			adapter: "slack",
			adapterId: "slack",
			actor: { id: "U1" },
			cause: { kind: "message" as const, messageId: "123.456" },
		};

		await emit(activity.events, { type: "message_accepted", origin: "heypi", message: context.message }, context);
		await emit(activity.events, { type: "todo_changed", origin: "heypi", job, text: "● Patch" }, context);

		expect(reactions).toEqual(["eyes"]);
		expect(context.todo?.replace).toHaveBeenCalledWith("● Patch");
		expect(requests).toEqual([]);
	});

	it("does not react to non-mention messages", async () => {
		const reactions: string[] = [];
		const activity = createSlackActivity(
			false,
			"eyes",
			async (_message, emoji) => {
				reactions.push(emoji);
			},
			async () => {},
		);
		const context = activityContext();
		context.message.mentioned = false;

		await emit(activity.events, { type: "message_accepted", origin: "heypi", message: context.message }, context);

		expect(reactions).toEqual([]);
	});

	it("uses native status across work, todo, resume, and completion", async () => {
		const requests: Array<{ thread_ts: string; status: string }> = [];
		const activity = createSlackActivity(
			true,
			undefined,
			async () => {},
			async (payload) => {
				requests.push({ thread_ts: payload.thread_ts, status: payload.status });
			},
		);
		const context = activityContext();
		const job = {
			id: "job",
			state: "running" as const,
			conversation: "C1",
			thread: "100.000",
			adapter: "slack",
			adapterId: "slack",
			actor: { id: "U1" },
			cause: { kind: "message" as const, messageId: "123.456" },
		};

		await emit(activity.events, { type: "message_accepted", origin: "heypi", message: context.message }, context);
		await emit(activity.events, { type: "tool_started", origin: "pi", job, tool: "bash" }, context);
		await emit(activity.events, { type: "todo_changed", origin: "heypi", job, text: "● Patch" }, context);
		await activity.resume({ conversation: "C1", thread: "100.000" });
		await emit(activity.events, { type: "message_completed", origin: "pi", job, text: "Done." }, context);
		await activity.stop();

		expect(context.todo?.replace).toHaveBeenCalledWith("● Patch");
		expect(requests).toEqual([
			{ thread_ts: "100.000", status: "Thinking..." },
			{ thread_ts: "100.000", status: "Working..." },
			{ thread_ts: "100.000", status: "Working..." },
			{ thread_ts: "100.000", status: "Working..." },
			{ thread_ts: "100.000", status: "" },
		]);
	});

	it("restores native status after busy messages", async () => {
		const statuses: string[] = [];
		const activity = createSlackActivity(
			true,
			undefined,
			async () => {},
			async ({ status }) => {
				statuses.push(status);
			},
		);
		const context = activityContext();
		await emit(activity.events, { type: "message_accepted", origin: "heypi", message: context.message }, context);
		await emit(
			activity.events,
			{
				type: "tool_started",
				origin: "pi",
				job: {
					id: "job",
					state: "running",
					conversation: "C1",
					thread: "100.000",
					adapter: "slack",
					adapterId: "slack",
					actor: { id: "U1" },
					cause: { kind: "message", messageId: "123.456" },
				},
				tool: "bash",
			},
			context,
		);
		await emit(activity.events, { type: "message_accepted", origin: "heypi", message: context.message }, context);
		await emit(activity.events, { type: "message_queued", origin: "heypi", message: context.message }, context);
		await emit(activity.events, { type: "message_steered", origin: "heypi", message: context.message }, context);
		await emit(activity.events, { type: "message_rejected", origin: "heypi", message: context.message }, context);

		expect(context.send).toHaveBeenCalledWith(expect.objectContaining({ text: expect.stringContaining("Queued") }));
		expect(context.send).toHaveBeenCalledTimes(3);
		expect(statuses).toEqual(["Thinking...", "Working...", "Working...", "Working...", "Working..."]);
	});

	it("uses the triggering message as the native DM thread", async () => {
		const threads: string[] = [];
		const activity = createSlackActivity(
			true,
			undefined,
			async () => {},
			async ({ thread_ts }) => {
				threads.push(thread_ts);
			},
		);
		const context = activityContext();
		context.message.thread = undefined;
		context.message.conversation = "D1";
		context.message.dm = true;

		await emit(activity.events, { type: "message_accepted", origin: "heypi", message: context.message }, context);

		expect(threads).toEqual(["123.456"]);
	});
});

describe("slackMessage", () => {
	it("routes bot mentions only through the app mention handler", () => {
		expect(slackMessageMentionsBot({ text: "hey <@UBOT>" }, { userId: "UBOT" })).toBe(true);
		expect(slackMessageMentionsBot({ text: "hey <@UOTHER>" }, { userId: "UBOT" })).toBe(false);
	});

	it("normalizes Slack app mentions", () => {
		expect(
			slackMessage(
				{
					ts: "123.456",
					channel: "C1",
					user: "U1",
					username: "Ronan",
					text: "hey <@BOT>",
					files: [{ id: "F1", name: "a.txt", url_private: "https://slack/file", mimetype: "text/plain" }],
				},
				true,
			),
		).toEqual({
			id: "123.456",
			adapter: "slack",
			adapterId: "slack",
			conversation: "C1",
			session: "123.456",
			thread: "123.456",
			user: { id: "U1", name: "Ronan", isBot: false },
			text: "hey <@BOT>",
			mentioned: true,
			dm: false,
			attachments: [{ id: "F1", name: "a.txt", url: "https://slack/file", mime: "text/plain" }],
		});
	});

	it("treats Slack IMs as DMs", () => {
		const message = slackMessage({ ts: "1", channel: "D1", channel_type: "im", user: "U1", text: "hi" }, false);
		expect(message.dm).toBe(true);
		expect(message.thread).toBeUndefined();
	});

	it("distinguishes Slack self messages from other bot messages", () => {
		const otherBot = slackMessage({ ts: "1", channel: "D1", channel_type: "im", bot_id: "B1", text: "bot" }, false, {
			botId: "SELF",
		}).user;
		expect(otherBot).toMatchObject({ id: "B1", isBot: true });
		expect(otherBot.isSelf).toBeUndefined();
		expect(
			slackMessage({ ts: "2", channel: "D1", channel_type: "im", bot_id: "B1", text: "bot" }, false, {
				botId: "B1",
			}).user,
		).toMatchObject({ id: "B1", isBot: true, isSelf: true });
		const subtype = slackMessage(
			{ ts: "3", channel: "D1", channel_type: "im", subtype: "message_changed", text: "edit" },
			false,
		).user;
		expect(subtype).toMatchObject({ id: "unknown", isBot: true });
		expect(subtype.isSelf).toBeUndefined();
		const noUser = slackMessage({ ts: "4", channel: "D1", channel_type: "im", text: "no user" }, false).user;
		expect(noUser).toMatchObject({ id: "unknown", isBot: true });
		expect(noUser.isSelf).toBeUndefined();
	});

	it("filters Slack message subtypes before normalization", () => {
		expect(slackMessageEventAllowed({ user: "U1", subtype: "file_share", text: "file" })).toBe(true);
		expect(slackMessageEventAllowed({ user: "U1", subtype: "me_message", text: "waves" })).toBe(true);
		expect(slackMessageEventAllowed({ user: "U1", subtype: "thread_broadcast", text: "broadcast" })).toBe(true);
		expect(slackMessageEventAllowed({ user: "U1", subtype: "message_changed", text: "edit" })).toBe(false);
		expect(slackMessageEventAllowed({ user: "U1", subtype: "message_deleted" })).toBe(false);
		expect(slackMessageEventAllowed({ bot_id: "B1", subtype: "bot_message", text: "bot" })).toBe(true);
		expect(slackMessageEventAllowed({ text: "empty sender" })).toBe(false);
	});

	it("preserves Slack thread roots", () => {
		expect(
			slackMessage({ ts: "124.000", thread_ts: "123.456", channel: "C1", user: "U1", text: "follow-up" }, true)
				.thread,
		).toBe("123.456");
	});

	it("renders approval message payloads", () => {
		expect(
			slackApprovalPayload({
				id: "abc",
				reason: "Run bash tool.",
				command: "git push",
				requestedBy: "@Ronan",
			}),
		).toMatchObject({
			text: [
				"*Approval required*",
				"- Reason: Run bash tool.",
				"- Command:\n```\ngit push\n```",
				"- Requested by: @Ronan",
			].join("\n"),
			blocks: [{ type: "section" }, { type: "actions" }],
		});
	});

	it("renders approval card payloads", () => {
		const payload = slackApprovalPayload({
			id: "abc",
			layout: "card",
			reason: "Run bash tool.",
			command: "git push",
			requestedBy: "@Ronan",
		});
		expect(payload.text).toBe("");
		expect(payload.blocks).toEqual([{ type: "actions", elements: expect.any(Array) }]);
		expect(payload.attachments?.[0]).toMatchObject({
			color: "#ECB22E",
			fallback: expect.stringContaining("Run bash tool."),
			blocks: [{ type: "section" }, { type: "section" }, { type: "section" }, { type: "section" }],
		});
	});
});
