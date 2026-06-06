// Telegram delivers updates over HTTP webhooks (no persistent connection), so the whole adapter is
// request-scoped and lives in the Worker — no bridge needed. These helpers keep the parsing and the
// outbound call pure and testable; index.ts wires them to the Durable Object.

export type TelegramMessage = { chatId: number; text: string };

type TelegramUpdate = {
	message?: { text?: string; chat?: { id?: number } };
};

/** Extracts the chat id and text from a Telegram Update, or null for updates we don't handle. */
export function parseTelegramUpdate(body: unknown): TelegramMessage | null {
	const update = body as TelegramUpdate;
	const text = update?.message?.text;
	const chatId = update?.message?.chat?.id;
	if (typeof text !== "string" || !text.trim() || typeof chatId !== "number") return null;
	return { chatId, text };
}

/** Sends a reply back to a Telegram chat via the Bot API. */
export async function sendTelegramMessage(token: string, chatId: number, text: string): Promise<void> {
	const res = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify({ chat_id: chatId, text: text.slice(0, 4096) }),
	});
	if (!res.ok) throw new Error(`telegram sendMessage ${res.status}: ${await res.text()}`);
}
