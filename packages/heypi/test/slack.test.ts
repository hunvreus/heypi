import { describe, expect, it } from "vitest";
import { slackMessage } from "../src/slack.js";

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
});
