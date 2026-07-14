import { describe, expect, it } from "vitest";
import { slackApprovalPayload, slackMessage, slackMessageEventAllowed } from "../src/slack.js";

describe("slackMessage", () => {
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
