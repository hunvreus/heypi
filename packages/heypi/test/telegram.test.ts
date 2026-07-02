import { describe, expect, it } from "vitest";
import { telegramMessage } from "../src/telegram.js";

describe("telegramMessage", () => {
	it("normalizes private messages", () => {
		expect(
			telegramMessage({
				message_id: 1,
				text: "hello",
				chat: { id: 10, type: "private" },
				from: { id: 20, username: "ronan" },
			}),
		).toEqual({
			id: "1",
			adapter: "telegram",
			account: "telegram",
			conversation: "10",
			user: { id: "20", name: "ronan", isBot: false },
			text: "hello",
			mentioned: false,
			dm: true,
			attachments: [],
		});
	});

	it("detects bot mentions in group messages", () => {
		expect(
			telegramMessage(
				{
					message_id: 1,
					text: "hey @Codex",
					chat: { id: 10, type: "supergroup" },
					from: { id: 20, first_name: "Ronan" },
				},
				"Codex",
			).mentioned,
		).toBe(true);
	});
});
