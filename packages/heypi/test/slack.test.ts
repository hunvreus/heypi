import { describe, expect, it } from "vitest";
import { slackApprovalPayload, slackMessage } from "../src/slack.js";

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
			account: "slack",
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
		expect(slackMessage({ ts: "1", channel: "D1", channel_type: "im", user: "U1", text: "hi" }, false).dm).toBe(true);
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
