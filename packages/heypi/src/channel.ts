import { randomUUID } from "node:crypto";
import { appendFile, mkdir, readFile } from "node:fs/promises";
import { dirname } from "node:path";
import type { ChatMessage, ContextConfig } from "./types.js";

export type ChannelRecord =
	| ({ type: "inbound"; record: number } & ChatMessage)
	| { type: "turn_queued"; record: number; id: string; trigger: number }
	| { type: "turn_completed"; record: number; id: string; trigger: number; reply?: string }
	| { type: "turn_failed"; record: number; id: string; trigger: number; error: string };

export type Turn = {
	id: string;
	messageId: string;
	prompt: string;
};

type QueuedTurn = {
	id: string;
	trigger: number;
};

export type ChannelOptions = {
	logPath: string;
	context?: ContextConfig;
};

export type Channel = {
	load(): Promise<void>;
	ingest(message: ChatMessage): Promise<boolean>;
	next(): Turn | undefined;
	complete(reply?: string): Promise<void>;
	fail(error: string): Promise<void>;
	activeMessageId(): string | undefined;
	activeUser(): { id: string; name?: string } | undefined;
	findHistory(query?: ChatHistoryQuery): Array<ChannelRecord & { type: "inbound" }>;
};

export type ChatHistoryQuery = {
	query?: string;
	after?: string;
	before?: string;
	limit?: number;
};

export function createChannel(options: ChannelOptions): Channel {
	let records: ChannelRecord[] = [];
	const queued: QueuedTurn[] = [];
	let active: QueuedTurn | undefined;
	let nextRecord = 1;
	const context: Required<ContextConfig> = {
		mode: options.context?.mode ?? "current",
		maxMessages: options.context?.maxMessages ?? 20,
		maxChars: options.context?.maxChars ?? 12_000,
		includeBotMessages: options.context?.includeBotMessages ?? false,
		includeAttachments: options.context?.includeAttachments ?? true,
	};

	async function append(record: ChannelRecord): Promise<void> {
		records.push(record);
		await appendFile(options.logPath, `${JSON.stringify(record)}\n`, "utf8");
	}

	function isInbound(record: ChannelRecord): record is ChannelRecord & { type: "inbound" } {
		return record.type === "inbound";
	}

	function activeMessage(): (ChannelRecord & { type: "inbound" }) | undefined {
		if (!active) return undefined;
		const trigger = active.trigger;
		return records.find((record): record is ChannelRecord & { type: "inbound" } => {
			return isInbound(record) && record.record === trigger;
		});
	}

	function lastCompletedTrigger(): number {
		for (let index = records.length - 1; index >= 0; index--) {
			const record = records[index];
			if (record?.type === "turn_completed") return record.trigger;
		}
		return 0;
	}

	function restoreQueue(): void {
		queued.splice(0, queued.length);
		const finished = new Set<string>();
		for (const record of records) {
			if (record.type === "turn_completed" || record.type === "turn_failed") finished.add(record.id);
		}
		for (const record of records) {
			if (record.type === "turn_queued" && !finished.has(record.id)) {
				queued.push({ id: record.id, trigger: record.trigger });
			}
		}
	}

	function shouldTrigger(message: ChatMessage): boolean {
		if (message.user.isBot) return false;
		return message.dm || message.mentioned;
	}

	function formatMessage(message: ChannelRecord & { type: "inbound" }): string {
		const lines = [`- [uid:${message.user.id}] ${message.user.name ?? "unknown"}: ${message.text || "(no text)"}`];
		if (context.includeAttachments && message.attachments?.length) {
			lines.push("  attachments:");
			for (const attachment of message.attachments)
				lines.push(`  - ${attachment.path ?? attachment.url ?? attachment.name}`);
		}
		return lines.join("\n");
	}

	function buildPrompt(trigger: number): string {
		const boundary = context.mode === "current" ? trigger - 1 : lastCompletedTrigger();
		const prompt = records
			.filter(isInbound)
			.filter((record) => record.record > boundary && record.record <= trigger)
			.filter((record) => context.includeBotMessages || !record.user.isBot)
			.slice(-context.maxMessages)
			.map(formatMessage)
			.join("\n");
		return prompt.length > context.maxChars ? prompt.slice(-context.maxChars) : prompt;
	}

	return {
		async load() {
			await mkdir(dirname(options.logPath), { recursive: true });
			try {
				const text = await readFile(options.logPath, "utf8");
				records = text
					.split("\n")
					.filter(Boolean)
					.map((line) => JSON.parse(line) as ChannelRecord);
				nextRecord = records.reduce((max, record) => Math.max(max, record.record), 0) + 1;
				restoreQueue();
			} catch (error) {
				if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
			}
		},

		async ingest(message) {
			const record: ChannelRecord = { type: "inbound", record: nextRecord++, ...message };
			await append(record);
			if (!shouldTrigger(message)) return false;
			const turn = { id: randomUUID(), trigger: record.record };
			queued.push(turn);
			await append({ type: "turn_queued", record: nextRecord++, id: turn.id, trigger: turn.trigger });
			return true;
		},

		next() {
			if (active || queued.length === 0) return undefined;
			const turn = queued.shift();
			if (!turn) return undefined;
			active = turn;
			const message = activeMessage();
			return {
				id: turn.id,
				messageId: message?.thread ?? message?.id ?? turn.id,
				prompt: buildPrompt(turn.trigger),
			};
		},

		async complete(reply) {
			if (!active) return;
			await append({ type: "turn_completed", record: nextRecord++, id: active.id, trigger: active.trigger, reply });
			active = undefined;
		},

		async fail(error) {
			if (!active) return;
			await append({ type: "turn_failed", record: nextRecord++, id: active.id, trigger: active.trigger, error });
			active = undefined;
		},

		activeMessageId() {
			const message = activeMessage();
			return message?.thread ?? message?.id;
		},

		activeUser() {
			const user = activeMessage()?.user;
			if (!user) return undefined;
			return { id: user.id, name: user.name };
		},

		findHistory(query = {}) {
			const search = query.query?.trim().toLowerCase();
			const after = query.after ? Date.parse(query.after) : undefined;
			const before = query.before ? Date.parse(query.before) : undefined;
			const limit = Math.min(Math.max(query.limit ?? 25, 1), 100);
			const activeTrigger = active?.trigger;
			return records
				.filter(isInbound)
				.filter((record) => {
					if (record.record === activeTrigger) return false;
					if (record.user.isBot && !context.includeBotMessages) return false;
					if (search && !record.text.toLowerCase().includes(search)) return false;
					const time = record.time ? Date.parse(record.time) : undefined;
					if (after !== undefined && time !== undefined && time < after) return false;
					if (before !== undefined && time !== undefined && time > before) return false;
					return true;
				})
				.slice(-limit);
		},
	};
}
