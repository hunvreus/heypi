import { describe, expect, it } from "vitest";
import { telegramApprovalPayload, telegramMessage, telegramTypingPayload } from "../src/telegram.js";

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
			adapterId: "telegram",
			conversation: "10",
			thread: undefined,
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

	it("detects Telegram self messages by bot id", () => {
		expect(
			telegramMessage(
				{
					message_id: 1,
					text: "hello",
					chat: { id: 10, type: "private" },
					from: { id: 99, username: "codex", is_bot: true },
				},
				{ id: 99, username: "codex" },
			).user,
		).toMatchObject({ id: "99", name: "codex", isBot: true, isSelf: true });
	});

	it("distinguishes Telegram self messages from other bot messages", () => {
		expect(
			telegramMessage(
				{
					message_id: 1,
					text: "hello",
					chat: { id: 10, type: "private" },
					from: { id: 42, username: "other", is_bot: true },
				},
				{ id: 99, username: "codex" },
			).user,
		).toMatchObject({ id: "42", name: "other", isBot: true });
	});

	it("preserves Telegram forum topic ids", () => {
		expect(
			telegramMessage({
				message_id: 1,
				message_thread_id: 42,
				text: "hello",
				chat: { id: 10, type: "supergroup" },
				from: { id: 20 },
			}).thread,
		).toBe("42");
	});

	it("renders approval inline keyboard", () => {
		expect(
			telegramApprovalPayload({
				id: "abc",
				conversation: "10",
				thread: "99",
				reason: "Run bash tool.",
				command: "git push",
			}),
		).toEqual({
			chat_id: "10",
			message_thread_id: 99,
			text: ["*Approval required*", "- Reason: Run bash tool.", "- Command:\n```\ngit push\n```"].join("\n"),
			reply_markup: {
				inline_keyboard: [
					[
						{ text: "Approve", callback_data: "heypi_approve:abc" },
						{ text: "Reject", callback_data: "heypi_reject:abc" },
					],
				],
			},
		});
	});

	it("renders typing acknowledgements", () => {
		expect(
			telegramTypingPayload({
				id: "1",
				adapter: "telegram",
				adapterId: "telegram",
				conversation: "10",
				user: { id: "20" },
				text: "hello",
				mentioned: false,
				dm: true,
			}),
		).toEqual({ chat_id: "10", action: "typing" });
	});
});
