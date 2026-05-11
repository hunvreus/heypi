import type { MessageRepo, MessageRow } from "./repo-message.js";
import { decode } from "./transcript.js";
import type { StoredMessage } from "./types.js";

const EMPTY_USAGE = {
	input: 0,
	output: 0,
	cacheRead: 0,
	cacheWrite: 0,
	totalTokens: 0,
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

function assistantMessage(text: string, timestamp: number): StoredMessage {
	return {
		role: "assistant",
		content: [{ type: "text", text }],
		api: "openai-responses",
		provider: "openai",
		model: "stored",
		usage: EMPTY_USAGE,
		stopReason: "stop",
		timestamp,
	} as StoredMessage;
}

function toStoredMessage(row: MessageRow): StoredMessage | undefined {
	const pi = decode(row.data);
	if (pi) return pi;
	if (row.role === "user") {
		return { role: "user", content: row.text, timestamp: row.createdAt } as StoredMessage;
	}
	if (row.role === "assistant") {
		return assistantMessage(row.text, row.createdAt);
	}
	if (row.role === "system" || row.role === "tool") {
		return { role: "user", content: `[${row.role}] ${row.text}`, timestamp: row.createdAt } as StoredMessage;
	}
	return undefined;
}

export class SessionStore {
	constructor(private readonly messages: MessageRepo) {}

	async load(threadId: string, inputMessageId?: string): Promise<StoredMessage[]> {
		const rows = await this.messages.listForThread(threadId, { excludeId: inputMessageId });
		return rows.map(toStoredMessage).filter((row): row is StoredMessage => Boolean(row));
	}
}
