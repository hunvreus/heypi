import { afterEach, describe, expect, it, vi } from "vitest";
import { telegram, telegramApprovalPayload, telegramMessage, telegramTypingPayload } from "../src/telegram.js";

afterEach(() => vi.unstubAllGlobals());

describe("telegramMessage", () => {
	it("retries rate-limited API calls using Telegram retry metadata", async () => {
		let getMeCalls = 0;
		vi.stubGlobal("fetch", async (input: string | URL | Request) => {
			const method = String(input).split("/").at(-1);
			if (method === "getMe") {
				getMeCalls += 1;
				if (getMeCalls === 1) {
					return Response.json(
						{ ok: false, description: "Too Many Requests", parameters: { retry_after: 0 } },
						{ status: 429 },
					);
				}
				return Response.json({ ok: true, result: { id: 99, username: "codex" } });
			}
			return Response.json({ ok: true, result: [] });
		});
		const adapter = telegram({ token: "test", pollMs: 10_000, retry: { minDelayMs: 0 } });

		await adapter.start({
			agentId: "agent",
			logger: { debug() {}, info() {}, warn() {}, error() {} },
			receive: async () => {},
		});

		expect(getMeCalls).toBe(2);
		await adapter.stop?.();
	});

	it("keeps polling while an accepted turn is running", async () => {
		let polls = 0;
		let secondPoll: (() => void) | undefined;
		const polled = new Promise<void>((resolve) => {
			secondPoll = resolve;
		});
		vi.stubGlobal("fetch", async (input: string | URL | Request) => {
			const method = String(input).split("/").at(-1);
			if (method === "getMe") return Response.json({ ok: true, result: { id: 99, username: "codex" } });
			polls += 1;
			if (polls > 1) {
				secondPoll?.();
				return Response.json({ ok: true, result: [] });
			}
			return Response.json({
				ok: true,
				result: [
					{
						update_id: 1,
						message: { message_id: 1, text: "hello", chat: { id: 10, type: "private" }, from: { id: 20 } },
					},
				],
			});
		});
		const adapter = telegram({ token: "test", pollMs: 0 });
		await adapter.start({
			agentId: "agent",
			logger: { debug() {}, info() {}, warn() {}, error() {} },
			enqueue: async () => {},
			receive: () => new Promise(() => undefined),
		});

		await Promise.race([
			polled,
			new Promise((_, reject) => setTimeout(() => reject(new Error("poll blocked")), 500)),
		]);
		expect(polls).toBeGreaterThan(1);
		await adapter.stop?.();
	});

	it("does not advance the polling offset until intake succeeds", async () => {
		const offsets: number[] = [];
		let observed: (() => void) | undefined;
		const polled = new Promise<void>((resolve) => {
			observed = resolve;
		});
		vi.stubGlobal("fetch", async (input: string | URL | Request, init?: RequestInit) => {
			const method = String(input).split("/").at(-1);
			if (method === "getMe") return Response.json({ ok: true, result: { id: 99 } });
			const body = JSON.parse(String(init?.body)) as { offset: number };
			offsets.push(body.offset);
			if (offsets.length === 3) {
				observed?.();
				return Response.json({ ok: true, result: [] });
			}
			return Response.json({
				ok: true,
				result: [
					{
						update_id: 1,
						message: { message_id: 1, text: "hello", chat: { id: 10, type: "private" }, from: { id: 20 } },
					},
				],
			});
		});
		let intakes = 0;
		const adapter = telegram({ token: "test", pollMs: 0 });
		await adapter.start({
			agentId: "agent",
			logger: { debug() {}, info() {}, warn() {}, error() {} },
			enqueue: async () => {
				intakes += 1;
				if (intakes === 1) throw new Error("intake failed");
			},
			receive: async () => {},
		});

		await Promise.race([
			polled,
			new Promise((_, reject) => setTimeout(() => reject(new Error("poll blocked")), 500)),
		]);
		expect(offsets.slice(0, 3)).toEqual([0, 0, 2]);
		await adapter.stop?.();
	});

	it("drops a poison update after bounded retries and processes later updates", async () => {
		const offsets: number[] = [];
		let observed: (() => void) | undefined;
		const processed = new Promise<void>((resolve) => {
			observed = resolve;
		});
		vi.stubGlobal("fetch", async (input: string | URL | Request, init?: RequestInit) => {
			const method = String(input).split("/").at(-1);
			if (method === "getMe") return Response.json({ ok: true, result: { id: 99 } });
			const body = JSON.parse(String(init?.body)) as { offset: number };
			offsets.push(body.offset);
			if (body.offset >= 3) {
				observed?.();
				return Response.json({ ok: true, result: [] });
			}
			return Response.json({
				ok: true,
				result: [
					{
						update_id: 1,
						message: { message_id: 1, text: "bad", chat: { id: 10, type: "private" }, from: { id: 20 } },
					},
					{
						update_id: 2,
						message: { message_id: 2, text: "good", chat: { id: 10, type: "private" }, from: { id: 20 } },
					},
				],
			});
		});
		const received: string[] = [];
		const dropped: string[] = [];
		const adapter = telegram({ token: "test", pollMs: 0 });
		await adapter.start({
			agentId: "agent",
			logger: {
				debug() {},
				info() {},
				warn() {},
				error(event) {
					dropped.push(event);
				},
			},
			receive: async (message) => {
				if (message.id === "1") throw new Error("permanent intake failure");
				received.push(message.id);
			},
		});

		await Promise.race([
			processed,
			new Promise((_, reject) => setTimeout(() => reject(new Error("poll blocked")), 500)),
		]);
		expect(offsets.slice(0, 4)).toEqual([0, 0, 0, 3]);
		expect(received).toEqual(["2"]);
		expect(dropped).toContain("adapter_telegram_update_dropped");
		await adapter.stop?.();
	});

	it("times out stalled API response bodies", async () => {
		vi.stubGlobal("fetch", (input: string | URL | Request, init?: RequestInit) => {
			const method = String(input).split("/").at(-1);
			if (method === "getMe") return Promise.resolve(Response.json({ ok: true, result: { id: 99 } }));
			if (method === "getUpdates") return Promise.resolve(Response.json({ ok: true, result: [] }));
			const signal = init?.signal;
			return Promise.resolve(
				new Response(
					new ReadableStream({
						start(controller) {
							signal?.addEventListener("abort", () => controller.error(signal.reason), { once: true });
						},
					}),
					{ status: 200 },
				),
			);
		});
		const adapter = telegram({ token: "test", pollMs: 10_000, timeoutMs: 5, retry: false });
		await adapter.start({
			agentId: "agent",
			logger: { debug() {}, info() {}, warn() {}, error() {} },
			receive: async () => {},
		});

		await expect(adapter.send({ conversation: "10", text: "hello" })).rejects.toThrow("Telegram request timed out");
		await adapter.stop?.();
	});

	it("ignores edited messages instead of starting a new turn", async () => {
		let polls = 0;
		const receive = vi.fn();
		let observed: (() => void) | undefined;
		const polled = new Promise<void>((resolve) => {
			observed = resolve;
		});
		vi.stubGlobal("fetch", async (input: string | URL | Request) => {
			const method = String(input).split("/").at(-1);
			if (method === "getMe") return Response.json({ ok: true, result: { id: 99, username: "codex" } });
			polls += 1;
			if (polls > 1) {
				observed?.();
				return Response.json({ ok: true, result: [] });
			}
			return Response.json({
				ok: true,
				result: [
					{
						update_id: 1,
						edited_message: {
							message_id: 1,
							text: "edited",
							chat: { id: 10, type: "private" },
							from: { id: 20 },
						},
					},
				],
			});
		});
		const adapter = telegram({ token: "test", pollMs: 0 });
		await adapter.start({
			agentId: "agent",
			logger: { debug() {}, info() {}, warn() {}, error() {} },
			receive,
		});

		await Promise.race([
			polled,
			new Promise((_, reject) => setTimeout(() => reject(new Error("poll blocked")), 500)),
		]);
		expect(receive).not.toHaveBeenCalled();
		await adapter.stop?.();
	});

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

	it("preserves reply targets for logical conversation routing", () => {
		expect(
			telegramMessage({
				message_id: 2,
				text: "continue",
				chat: { id: 10, type: "supergroup" },
				from: { id: 20 },
				reply_to_message: { message_id: 1 },
			}).replyTo,
		).toBe("1");
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
