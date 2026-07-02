import { randomUUID } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import type { ChatMessage, ContextConfig } from "./types.js";

export type ConversationRecord =
	| ({ type: "inbound"; record: number } & ChatMessage)
	| { type: "job_queued"; record: number; id: string; trigger: number }
	| { type: "job_completed"; record: number; id: string; trigger: number; reply?: string }
	| { type: "job_failed"; record: number; id: string; trigger: number; error: string };

export type DispatchJob = {
	id: string;
	trigger: number;
	messageId: string;
	prompt: string;
};

export type ChatHistoryQuery = {
	query?: string;
	after?: string;
	before?: string;
	limit?: number;
};

type PendingJob = {
	id: string;
	trigger: number;
};

export type ConversationRuntimeOptions = {
	logPath: string;
	context?: ContextConfig;
};

export class ConversationRuntime {
	private records: ConversationRecord[] = [];
	private pending: PendingJob[] = [];
	private active: PendingJob | undefined;
	private nextRecord = 1;
	private readonly context: Required<ContextConfig>;

	constructor(private readonly options: ConversationRuntimeOptions) {
		this.context = {
			range: options.context?.range ?? "current",
			includeSince: options.context?.includeSince ?? "lastCompletedTrigger",
			maxMessages: options.context?.maxMessages ?? 20,
			maxChars: options.context?.maxChars ?? 12_000,
			includeBotMessages: options.context?.includeBotMessages ?? false,
			includeAttachments: options.context?.includeAttachments ?? true,
		};
	}

	async load(): Promise<void> {
		await mkdir(dirname(this.options.logPath), { recursive: true });
		try {
			const text = await readFile(this.options.logPath, "utf8");
			this.records = text
				.split("\n")
				.filter(Boolean)
				.map((line) => JSON.parse(line) as ConversationRecord);
			this.nextRecord = this.records.reduce((max, record) => Math.max(max, record.record), 0) + 1;
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
		}
	}

	async ingest(message: ChatMessage): Promise<boolean> {
		const record: ConversationRecord = { type: "inbound", record: this.nextRecord++, ...message };
		await this.append(record);
		if (!this.shouldTrigger(record)) return false;
		const job: PendingJob = { id: randomUUID(), trigger: record.record };
		this.pending.push(job);
		await this.append({ type: "job_queued", record: this.nextRecord++, id: job.id, trigger: job.trigger });
		return true;
	}

	beginNext(): DispatchJob | undefined {
		if (this.active || this.pending.length === 0) return undefined;
		const job = this.pending.shift();
		if (!job) return undefined;
		this.active = job;
		const trigger = this.records.find(
			(record): record is ConversationRecord & { type: "inbound" } =>
				record.type === "inbound" && record.record === job.trigger,
		);
		return {
			id: job.id,
			trigger: job.trigger,
			messageId: trigger?.id ?? job.id,
			prompt: this.buildPrompt(job.trigger),
		};
	}

	activeMessageId(): string | undefined {
		return this.activeMessage()?.id;
	}

	activeUserName(): string | undefined {
		const user = this.activeMessage()?.user;
		return user?.name ?? user?.id;
	}

	private activeMessage(): (ConversationRecord & { type: "inbound" }) | undefined {
		if (!this.active) return undefined;
		return this.records.find(
			(record): record is ConversationRecord & { type: "inbound" } =>
				record.type === "inbound" && record.record === this.active?.trigger,
		);
	}

	async complete(reply?: string): Promise<void> {
		if (!this.active) return;
		await this.append({
			type: "job_completed",
			record: this.nextRecord++,
			id: this.active.id,
			trigger: this.active.trigger,
			reply,
		});
		this.active = undefined;
	}

	async fail(error: string): Promise<void> {
		if (!this.active) return;
		await this.append({
			type: "job_failed",
			record: this.nextRecord++,
			id: this.active.id,
			trigger: this.active.trigger,
			error,
		});
		this.active = undefined;
	}

	findHistory(query: ChatHistoryQuery = {}): Array<ConversationRecord & { type: "inbound" }> {
		const search = query.query?.trim().toLowerCase();
		const after = query.after ? Date.parse(query.after) : undefined;
		const before = query.before ? Date.parse(query.before) : undefined;
		const limit = Math.min(Math.max(query.limit ?? 25, 1), 100);
		return this.records
			.filter((record): record is ConversationRecord & { type: "inbound" } => record.type === "inbound")
			.filter((record) => {
				if (record.user.isBot && !this.context.includeBotMessages) return false;
				if (search && !record.text.toLowerCase().includes(search)) return false;
				const time = record.time ? Date.parse(record.time) : undefined;
				if (after !== undefined && time !== undefined && time < after) return false;
				if (before !== undefined && time !== undefined && time > before) return false;
				return true;
			})
			.slice(-limit);
	}

	private shouldTrigger(message: ConversationRecord & { type: "inbound" }): boolean {
		if (message.user.isBot) return false;
		return message.dm || message.mentioned;
	}

	private lastCompletedTrigger(): number {
		for (let index = this.records.length - 1; index >= 0; index--) {
			const record = this.records[index];
			if (record?.type === "job_completed") return record.trigger;
		}
		return 0;
	}

	private buildPrompt(triggerRecord: number): string {
		const min =
			this.context.range === "current"
				? triggerRecord - 1
				: this.context.includeSince === "lastCompletedTrigger"
					? this.lastCompletedTrigger()
					: 0;
		const messages = this.records
			.filter((record): record is ConversationRecord & { type: "inbound" } => record.type === "inbound")
			.filter((record) => record.record > min && record.record <= triggerRecord)
			.filter((record) => this.context.includeBotMessages || !record.user.isBot)
			.slice(-this.context.maxMessages);
		const lines = messages.map((message) => this.formatMessage(message));
		const prompt = lines.join("\n");
		return prompt.length > this.context.maxChars ? prompt.slice(-this.context.maxChars) : prompt;
	}

	private formatMessage(message: ConversationRecord & { type: "inbound" }): string {
		const lines = [`- [uid:${message.user.id}] ${message.user.name ?? "unknown"}: ${message.text || "(no text)"}`];
		if (this.context.includeAttachments && message.attachments?.length) {
			lines.push("  attachments:");
			for (const attachment of message.attachments) lines.push(`  - ${attachment.path ?? attachment.url ?? attachment.name}`);
		}
		return lines.join("\n");
	}

	private async append(record: ConversationRecord): Promise<void> {
		this.records.push(record);
		await writeFile(this.options.logPath, `${this.records.map((entry) => JSON.stringify(entry)).join("\n")}\n`);
	}
}
