import { randomUUID } from "node:crypto";
import { and, desc, eq, lt, ne } from "drizzle-orm";
import { message } from "../db/schema.js";
import type { Db } from "./db.js";
import { decode } from "./transcript.js";
import type { HistoryMessage } from "./types.js";

export type MessageRow = typeof message.$inferSelect;

export class MessageRepo {
	constructor(private readonly db: Db) {}

	async create(input: {
		threadId: string;
		provider: string;
		providerEventId?: string;
		role: string;
		actor?: string;
		text: string;
		data?: string;
		state?: string;
		createdAt?: number;
	}): Promise<MessageRow> {
		return (await this.createOnce(input)).row;
	}

	async createOnce(input: {
		threadId: string;
		provider: string;
		providerEventId?: string;
		role: string;
		actor?: string;
		text: string;
		data?: string;
		state?: string;
		createdAt?: number;
	}): Promise<{ row: MessageRow; inserted: boolean }> {
		const existing = input.providerEventId
			? await this.getByProviderEvent(input.provider, input.providerEventId)
			: undefined;
		if (existing) return { row: existing, inserted: false };

		const id = randomUUID();
		const now = input.createdAt ?? Date.now();
		await this.db.insert(message).values({
			id,
			threadId: input.threadId,
			provider: input.provider,
			providerEventId: input.providerEventId,
			role: input.role,
			actor: input.actor,
			text: input.text,
			data: input.data,
			state: input.state ?? "done",
			createdAt: now,
			updatedAt: now,
		});
		const row = await this.get(id);
		if (!row) throw new Error("message insert failed");
		return { row, inserted: true };
	}

	async get(id: string): Promise<MessageRow | undefined> {
		const rows = await this.db.select().from(message).where(eq(message.id, id)).limit(1);
		return rows[0];
	}

	async getByProviderEvent(provider: string, eventId: string): Promise<MessageRow | undefined> {
		const rows = await this.db
			.select()
			.from(message)
			.where(and(eq(message.provider, provider), eq(message.providerEventId, eventId)))
			.limit(1);
		return rows[0];
	}

	async listForThread(threadId: string, input?: { limit?: number; excludeId?: string }): Promise<MessageRow[]> {
		const limit = input?.limit ?? 40;
		const conditions = [eq(message.threadId, threadId), eq(message.state, "done")];
		if (input?.excludeId) conditions.push(ne(message.id, input.excludeId));
		const rows = await this.db
			.select()
			.from(message)
			.where(and(...conditions))
			.orderBy(desc(message.createdAt))
			.limit(limit);
		return rows.reverse();
	}

	async search(input: {
		threadId: string;
		query?: string;
		limit?: number;
		before?: number;
		includeTools?: boolean;
	}): Promise<HistoryMessage[]> {
		const limit = Math.max(1, Math.min(input.limit ?? 20, 100));
		const conditions = [eq(message.threadId, input.threadId), eq(message.state, "done")];
		if (input.before !== undefined) conditions.push(lt(message.createdAt, input.before));
		const query = input.query?.trim().toLowerCase();
		const rows = await this.db
			.select()
			.from(message)
			.where(and(...conditions))
			.orderBy(desc(message.createdAt))
			.limit(query ? Math.max(limit * 5, 100) : limit);
		const out: HistoryMessage[] = [];
		for (const row of rows) {
			if (!input.includeTools && isToolRole(row.role)) continue;
			if (query && !`${row.actor ?? ""}\n${row.role}\n${row.text}`.toLowerCase().includes(query)) continue;
			out.push({ id: row.id, role: row.role, actor: row.actor, text: row.text, createdAt: row.createdAt });
			if (out.length >= limit) break;
		}
		return out.reverse();
	}

	async getToolResult(threadId: string, toolCallId: string): Promise<MessageRow | undefined> {
		const rows = await this.listForThread(threadId, { limit: 200 });
		return rows.find((row) => {
			if (row.role !== "toolResult") return false;
			const pi = decode(row.data);
			return hasToolCallId(pi) && pi.toolCallId === toolCallId;
		});
	}

	async update(id: string, input: { text: string; data?: string; state?: string; createdAt?: number }): Promise<void> {
		const values = {
			text: input.text,
			data: input.data,
			state: input.state ?? "done",
			updatedAt: Date.now(),
			...(input.createdAt === undefined ? {} : { createdAt: input.createdAt }),
		};
		await this.db.update(message).set(values).where(eq(message.id, id));
	}
}

function isToolRole(role: string): boolean {
	return role === "tool" || role === "toolResult";
}

function hasToolCallId(value: unknown): value is { toolCallId: string } {
	return (
		value !== null &&
		typeof value === "object" &&
		"toolCallId" in value &&
		typeof (value as { toolCallId?: unknown }).toolCallId === "string"
	);
}
