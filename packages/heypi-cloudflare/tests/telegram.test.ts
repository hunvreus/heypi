import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import { parseTelegramUpdate, sendTelegramMessage } from "../src/telegram.js";

const realFetch = globalThis.fetch;
afterEach(() => {
	globalThis.fetch = realFetch;
});

test("parseTelegramUpdate extracts chat id and text from a message update", () => {
	assert.deepEqual(parseTelegramUpdate({ message: { chat: { id: 42 }, text: "hello" } }), { chatId: 42, text: "hello" });
});

test("parseTelegramUpdate ignores updates without usable message text", () => {
	assert.equal(parseTelegramUpdate({ my_chat_member: {} }), null);
	assert.equal(parseTelegramUpdate({ message: { chat: { id: 1 } } }), null);
	assert.equal(parseTelegramUpdate({ message: { chat: { id: 1 }, text: "   " } }), null);
	assert.equal(parseTelegramUpdate({ message: { text: "no chat" } }), null);
});

test("sendTelegramMessage posts to the Bot API sendMessage endpoint", async () => {
	let captured: { url: string; body: unknown } | undefined;
	globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
		captured = { url: String(input), body: JSON.parse(String(init?.body)) };
		return new Response("{}", { status: 200 });
	}) as typeof fetch;

	await sendTelegramMessage("TOKEN", 42, "hi there");

	assert.equal(captured?.url, "https://api.telegram.org/botTOKEN/sendMessage");
	assert.deepEqual(captured?.body, { chat_id: 42, text: "hi there" });
});

test("sendTelegramMessage throws on a non-2xx response", async () => {
	globalThis.fetch = (async () => new Response("bad", { status: 400 })) as typeof fetch;
	await assert.rejects(() => sendTelegramMessage("TOKEN", 1, "x"), /telegram sendMessage 400/);
});
