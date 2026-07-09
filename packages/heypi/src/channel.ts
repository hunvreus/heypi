import { randomUUID } from "node:crypto";
import { appendFile, mkdir, readFile } from "node:fs/promises";
import { dirname } from "node:path";
import type { ChatJob } from "./events.js";
import type { ChatMessage } from "./types.js";

export type ChannelRecord =
	| ({ type: "inbound"; record: number } & ChatMessage)
	| { type: "turn_queued"; record: number; id: string; trigger: number }
	| { type: "turn_completed"; record: number; id: string; trigger: number; reply?: string }
	| { type: "turn_failed"; record: number; id: string; trigger: number; error: string }
	| { type: "turn_canceled"; record: number; id: string; trigger: number; reason?: string };

export type Turn = {
	id: string;
	replyThread?: string;
	prompt: string;
};

type QueuedTurn = {
	id: string;
	trigger: number;
};

export type ChannelOptions = {
	logPath: string;
};

export type Channel = {
	load(): Promise<void>;
	ingest(message: ChatMessage): Promise<boolean>;
	next(): Turn | undefined;
	jobs(): ChatJob[];
	cancelQueued(reason?: string): Promise<number>;
	cancelActive(reason?: string): Promise<boolean>;
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

	function restoreQueue(): void {
		queued.splice(0, queued.length);
		const finished = new Set<string>();
		for (const record of records) {
			if (record.type === "turn_completed" || record.type === "turn_failed" || record.type === "turn_canceled") {
				finished.add(record.id);
			}
		}
		for (const record of records) {
			if (record.type === "turn_queued" && !finished.has(record.id)) {
				queued.push({ id: record.id, trigger: record.trigger });
			}
		}
	}

	function shouldTrigger(message: ChatMessage): boolean {
		if (message.user.isSelf) return false;
		if (!hasContent(message)) return false;
		return message.dm || message.mentioned;
	}

	function hasContent(message: ChatMessage): boolean {
		return message.text.trim().length > 0 || Boolean(message.attachments?.length);
	}

	function formatMessage(message: ChannelRecord & { type: "inbound" }): string {
		const lines = [`- [uid:${message.user.id}] ${message.user.name ?? "unknown"}: ${message.text || "(no text)"}`];
		if (message.attachments?.length) {
			lines.push("  attachments:");
			for (const attachment of message.attachments)
				lines.push(`  - ${attachment.path ?? attachment.url ?? attachment.name}`);
		}
		return lines.join("\n");
	}

	function buildPrompt(trigger: number): string {
		const boundary = trigger - 1;
		const prompt = records
			.filter(isInbound)
			.filter((record) => record.record > boundary && record.record <= trigger)
			.map(formatMessage)
			.join("\n");
		return prompt;
	}

	function jobFor(turn: QueuedTurn, state: ChatJob["state"]): ChatJob | undefined {
		const trigger = records.find((record): record is ChannelRecord & { type: "inbound" } => {
			return isInbound(record) && record.record === turn.trigger;
		});
		if (!trigger) return undefined;
		return {
			id: turn.id,
			state,
			adapter: trigger.adapter,
			account: trigger.account,
			conversation: trigger.conversation,
			thread: trigger.thread,
			actor: { id: trigger.user.id, name: trigger.user.name },
		};
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
				replyThread: message?.thread,
				prompt: buildPrompt(turn.trigger),
			};
		},

		jobs() {
			return [
				...(active ? [jobFor(active, "running")].filter((job): job is ChatJob => Boolean(job)) : []),
				...queued.map((turn) => jobFor(turn, "queued")).filter((job): job is ChatJob => Boolean(job)),
			];
		},

		async cancelQueued(reason) {
			const turns = queued.splice(0, queued.length);
			for (const turn of turns) {
				await append({
					type: "turn_canceled",
					record: nextRecord++,
					id: turn.id,
					trigger: turn.trigger,
					reason,
				});
			}
			return turns.length;
		},

		async cancelActive(reason) {
			if (!active) return false;
			await append({
				type: "turn_canceled",
				record: nextRecord++,
				id: active.id,
				trigger: active.trigger,
				reason,
			});
			active = undefined;
			return true;
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
			return message?.thread;
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
					if (record.user.isBot) return false;
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
