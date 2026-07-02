import type { Adapter, ChatMessage } from "./types.js";

export type TelegramConfig = {
	name?: string;
	token: string;
	botUsername?: string;
	pollMs?: number;
};

export type TelegramUpdate = {
	update_id: number;
	message?: TelegramMessage;
};

export type TelegramMessage = {
	message_id: number;
	text?: string;
	chat: {
		id: number;
		type?: string;
		title?: string;
	};
	from?: {
		id: number;
		username?: string;
		first_name?: string;
		is_bot?: boolean;
	};
	document?: { file_id: string; file_name?: string; mime_type?: string };
	photo?: Array<{ file_id: string }>;
};

export function telegramMessage(message: TelegramMessage, botUsername?: string): ChatMessage {
	const text = message.text ?? "";
	const username = botUsername?.replace(/^@/, "");
	return {
		id: String(message.message_id),
		adapter: "telegram",
		account: "telegram",
		conversation: String(message.chat.id),
		user: {
			id: String(message.from?.id ?? "unknown"),
			name: message.from?.username ?? message.from?.first_name,
			isBot: message.from?.is_bot === true,
		},
		text,
		mentioned: username ? new RegExp(`@${escapeRegExp(username)}\\b`, "i").test(text) : false,
		dm: message.chat.type === "private",
		attachments: [
			...(message.document
				? [
						{
							id: message.document.file_id,
							name: message.document.file_name,
							mime: message.document.mime_type,
						},
					]
				: []),
			...(message.photo?.map((photo) => ({ id: photo.file_id, name: "photo" })) ?? []),
		],
	};
}

export function telegram(config: TelegramConfig): Adapter {
	let running = false;
	let offset = 0;
	const pollMs = config.pollMs ?? 1500;
	const api = `https://api.telegram.org/bot${config.token}`;

	async function call<T>(method: string, body: Record<string, unknown>): Promise<T> {
		const response = await fetch(`${api}/${method}`, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify(body),
		});
		if (!response.ok) throw new Error(`Telegram ${method} failed: ${response.status}`);
		const payload = (await response.json()) as { ok: boolean; result: T; description?: string };
		if (!payload.ok) throw new Error(payload.description ?? `Telegram ${method} failed`);
		return payload.result;
	}

	async function poll(receive: (message: ChatMessage) => Promise<void>): Promise<void> {
		while (running) {
			const updates = await call<TelegramUpdate[]>("getUpdates", { timeout: 20, offset });
			for (const update of updates) {
				offset = Math.max(offset, update.update_id + 1);
				if (!update.message) continue;
				const message = telegramMessage(update.message, config.botUsername);
				if (message.user.isBot) continue;
				if (!message.dm && !message.mentioned) continue;
				await receive(message);
			}
			await new Promise((resolve) => setTimeout(resolve, pollMs));
		}
	}

	return {
		kind: "telegram",
		name: config.name,
		start(context) {
			running = true;
			void poll(context.receive).catch((error) => {
				context.logger.error("adapter.telegram.error", {
					error: error instanceof Error ? error.message : String(error),
				});
			});
			context.logger.info("adapter.telegram.start");
		},
		stop() {
			running = false;
		},
		async send(message) {
			const result = await call<{ message_id: number }>("sendMessage", {
				chat_id: message.conversation,
				reply_to_message_id: message.thread ? Number(message.thread) : undefined,
				text: message.text,
			});
			return { id: String(result.message_id) };
		},
	};
}

function escapeRegExp(value: string): string {
	return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
