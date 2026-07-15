import { randomUUID } from "node:crypto";
import type { FileHandle } from "node:fs/promises";
import { appendFile, mkdir, open, readFile, rm } from "node:fs/promises";
import { dirname } from "node:path";
import type { ChatJob, TurnCause } from "./events.js";
import type { BusyMode, ChatMessage, SendMessage } from "./types.js";

export type ChannelRecord =
	| ({ type: "inbound"; record: number } & ChatMessage)
	| ({ type: "outbound"; record: number; message?: string; time: string } & SendMessage)
	| {
			type: "trigger";
			record: number;
			adapter: string;
			adapterId: string;
			conversation: string;
			thread?: string;
			prompt: string;
			actor: { id: string; name?: string };
			cause: TurnCause;
			time: string;
	  }
	| { type: "turn_queued"; record: number; id: string; trigger: number }
	| { type: "turn_steered"; record: number; id: string; trigger: number }
	| { type: "turn_rejected"; record: number; trigger: number }
	| { type: "turn_completed"; record: number; id: string; trigger: number; reply?: string }
	| { type: "turn_failed"; record: number; id: string; trigger: number; error: string }
	| { type: "turn_canceled"; record: number; id: string; trigger: number; reason?: string };

export type Turn = {
	id: string;
	message?: ChatMessage;
	adapter: string;
	adapterId: string;
	conversation: string;
	replyThread?: string;
	replyTo?: string;
	prompt: string;
	actor: { id: string; name?: string };
	cause: TurnCause;
};

export type TrustedTurn = {
	adapter: string;
	adapterId: string;
	conversation: string;
	thread?: string;
	prompt: string;
	actor: { id: string; name?: string };
	cause: Exclude<TurnCause, { kind: "message" }>;
};

type QueuedTurn = {
	id: string;
	trigger: number;
};

export type ChannelOptions = {
	logPath: string;
	lockPath?: string;
};

export type Channel = {
	load(): Promise<void>;
	close(): Promise<void>;
	accepts(message: ChatMessage): boolean;
	ingest(message: ChatMessage, busy?: BusyMode): Promise<IngestResult>;
	trigger(input: TrustedTurn): Promise<{ action: "started" | "queued"; id: string }>;
	next(): Turn | undefined;
	jobs(): ChatJob[];
	cancelQueued(reason?: string): Promise<ChatJob[]>;
	cancelActive(reason?: string): Promise<boolean>;
	outbound(message: SendMessage, remoteId?: string): Promise<void>;
	complete(reply?: string): Promise<void>;
	fail(error: string): Promise<void>;
	activeMessageId(): string | undefined;
	activeUser(): { id: string; name?: string } | undefined;
	findHistory(query?: ChatHistoryQuery): Array<ChannelRecord & ({ type: "inbound" } | { type: "outbound" })>;
};

export type IngestResult =
	| { action: "ignored" }
	| { action: "started"; id: string }
	| { action: "queued"; id: string }
	| { action: "steer"; id: string; prompt: string }
	| { action: "rejected" };

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
	let lock: FileHandle | undefined;

	async function lockChannel(): Promise<void> {
		if (!options.lockPath || lock) return;
		await mkdir(dirname(options.lockPath), { recursive: true });
		try {
			lock = await open(options.lockPath, "wx");
			await lock.writeFile(JSON.stringify({ pid: process.pid, time: new Date().toISOString() }), "utf8");
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
			const text = await readFile(options.lockPath, "utf8").catch(() => "");
			const pid = lockPid(text);
			if (Number.isFinite(pid) && processAlive(pid)) {
				throw new Error(`channel is already active in process ${pid}`);
			}
			await rm(options.lockPath, { force: true });
			lock = await open(options.lockPath, "wx");
			await lock.writeFile(JSON.stringify({ pid: process.pid, time: new Date().toISOString() }), "utf8");
		}
	}

	function processAlive(pid: number): boolean {
		try {
			process.kill(pid, 0);
			return true;
		} catch {
			return false;
		}
	}

	function lockPid(text: string): number {
		try {
			return Number(JSON.parse(text || "{}").pid);
		} catch {
			return NaN;
		}
	}

	async function releaseLock(): Promise<void> {
		if (!lock) return;
		await lock.close();
		lock = undefined;
		if (options.lockPath) await rm(options.lockPath, { force: true });
	}
	async function append(record: ChannelRecord): Promise<void> {
		records.push(record);
		await appendFile(options.logPath, `${JSON.stringify(record)}\n`, "utf8");
	}

	function isInbound(record: ChannelRecord): record is ChannelRecord & { type: "inbound" } {
		return record.type === "inbound";
	}

	function isMessageRecord(
		record: ChannelRecord,
	): record is ChannelRecord & ({ type: "inbound" } | { type: "outbound" }) {
		return record.type === "inbound" || record.type === "outbound";
	}

	function activeMessage(): (ChannelRecord & { type: "inbound" }) | undefined {
		if (!active) return undefined;
		const trigger = active.trigger;
		return records.find((record): record is ChannelRecord & { type: "inbound" } => {
			return isInbound(record) && record.record === trigger;
		});
	}

	function activeTrigger(): (ChannelRecord & ({ type: "inbound" } | { type: "trigger" })) | undefined {
		if (!active) return undefined;
		return records.find(
			(record): record is ChannelRecord & ({ type: "inbound" } | { type: "trigger" }) =>
				(record.type === "inbound" || record.type === "trigger") && record.record === active?.trigger,
		);
	}

	async function failInterruptedTurns(): Promise<void> {
		queued.splice(0, queued.length);
		const finished = new Set<string>();
		for (const record of records) {
			if (record.type === "turn_completed" || record.type === "turn_failed" || record.type === "turn_canceled") {
				finished.add(record.id);
			}
		}
		for (const record of records) {
			if (record.type === "turn_queued" && !finished.has(record.id)) {
				await append({
					type: "turn_failed",
					record: nextRecord++,
					id: record.id,
					trigger: record.trigger,
					error: "interrupted by restart",
				});
			}
		}
	}

	function shouldTrigger(message: ChatMessage): boolean {
		if (message.user.isSelf) return false;
		if (!hasContent(message)) return false;
		return message.dm || message.mentioned || followsTriggeredConversation(message);
	}

	function hasContent(message: ChatMessage): boolean {
		return message.text.trim().length > 0 || Boolean(message.attachments?.length);
	}

	function followsTriggeredConversation(message: ChatMessage): boolean {
		if (!message.session || message.session === message.id || message.dm) return false;
		if (message.replyTo) return true;
		return records.some((record) => {
			if (!isInbound(record)) return false;
			return record.dm || record.mentioned;
		});
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
		const trusted = records.find((record) => record.type === "trigger" && record.record === trigger);
		if (trusted?.type === "trigger") return trusted.prompt;
		const boundary = trigger - 1;
		const prompt = records
			.filter(isInbound)
			.filter((record) => record.record > boundary && record.record <= trigger)
			.map(formatMessage)
			.join("\n");
		return prompt;
	}

	function jobFor(turn: QueuedTurn, state: ChatJob["state"]): ChatJob | undefined {
		const trigger = records.find(
			(record): record is ChannelRecord & ({ type: "inbound" } | { type: "trigger" }) =>
				(record.type === "inbound" || record.type === "trigger") && record.record === turn.trigger,
		);
		if (!trigger) return undefined;
		const actor = trigger.type === "inbound" ? trigger.user : trigger.actor;
		return {
			id: turn.id,
			state,
			adapter: trigger.adapter,
			adapterId: trigger.adapterId,
			conversation: trigger.conversation,
			thread: trigger.thread,
			actor: { id: actor.id, name: actor.name },
			cause: trigger.type === "inbound" ? { kind: "message", messageId: trigger.id } : trigger.cause,
			startedAt: trigger.time,
		};
	}

	return {
		async load() {
			await mkdir(dirname(options.logPath), { recursive: true });
			await lockChannel();
			try {
				const text = await readFile(options.logPath, "utf8");
				records = text
					.split("\n")
					.filter(Boolean)
					.map((line) => JSON.parse(line) as ChannelRecord);
				nextRecord = records.reduce((max, record) => Math.max(max, record.record), 0) + 1;
				await failInterruptedTurns();
			} catch (error) {
				if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
			}
		},

		async close() {
			await releaseLock();
		},

		accepts(message) {
			return shouldTrigger(message);
		},

		async ingest(message, busy = "queue") {
			const record: ChannelRecord = {
				type: "inbound",
				record: nextRecord++,
				...message,
				time: message.time ?? new Date().toISOString(),
			};
			await append(record);
			if (!shouldTrigger(message)) return { action: "ignored" };
			if (active && busy === "reject") {
				await append({ type: "turn_rejected", record: nextRecord++, trigger: record.record });
				return { action: "rejected" };
			}
			if (active && busy === "steer") {
				await append({ type: "turn_steered", record: nextRecord++, id: active.id, trigger: record.record });
				return { action: "steer", id: active.id, prompt: buildPrompt(record.record) };
			}
			const turn = { id: randomUUID(), trigger: record.record };
			queued.push(turn);
			await append({ type: "turn_queued", record: nextRecord++, id: turn.id, trigger: turn.trigger });
			return { action: active ? "queued" : "started", id: turn.id };
		},

		async trigger(input) {
			const record: ChannelRecord = {
				type: "trigger",
				record: nextRecord++,
				...input,
				time: new Date().toISOString(),
			};
			await append(record);
			const turn = { id: randomUUID(), trigger: record.record };
			queued.push(turn);
			await append({ type: "turn_queued", record: nextRecord++, id: turn.id, trigger: turn.trigger });
			return { action: active ? "queued" : "started", id: turn.id };
		},

		next() {
			if (active || queued.length === 0) return undefined;
			const turn = queued.shift();
			if (!turn) return undefined;
			active = turn;
			const trigger = activeTrigger();
			if (!trigger) return undefined;
			const message = trigger.type === "inbound" ? trigger : undefined;
			const actor = trigger.type === "inbound" ? trigger.user : trigger.actor;
			const cause: TurnCause =
				trigger.type === "inbound" ? { kind: "message", messageId: trigger.id } : trigger.cause;
			return {
				id: turn.id,
				message,
				adapter: trigger.adapter,
				adapterId: trigger.adapterId,
				conversation: trigger.conversation,
				replyThread: trigger.thread,
				replyTo: message?.dm ? undefined : message?.id,
				prompt: buildPrompt(turn.trigger),
				actor: { id: actor.id, name: actor.name },
				cause,
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
			const jobs = turns.map((turn) => jobFor(turn, "queued")).filter((job): job is ChatJob => Boolean(job));
			for (const turn of turns) {
				await append({
					type: "turn_canceled",
					record: nextRecord++,
					id: turn.id,
					trigger: turn.trigger,
					reason,
				});
			}
			return jobs;
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

		async outbound(message, remoteId) {
			await append({
				type: "outbound",
				record: nextRecord++,
				message: remoteId,
				time: new Date().toISOString(),
				...message,
			});
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
				.filter(isMessageRecord)
				.filter((record) => {
					if (record.record === activeTrigger) return false;
					if (record.type === "inbound" && record.user.isBot) return false;
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
