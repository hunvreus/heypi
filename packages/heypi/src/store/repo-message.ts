import { randomUUID } from "node:crypto";
import { and, desc, eq, lt, ne } from "drizzle-orm";
import { message, thread } from "../db/schema.js";
import type { Db } from "./db.js";
import { clampLimit, clampOffset } from "./paging.js";
import type { HistoryMessage, Message, MessageWithThread } from "./types.js";

export class MessageRepo {
	constructor(private readonly db: Db) {}

	async create(input: {
		threadId: string;
		provider: string;
		kind?: string;
		providerEventId?: string;
		role: string;
		actor?: string;
		text: string;
		data?: string;
		state?: string;
		createdAt?: number;
	}): Promise<Message> {
		return (await this.createOnce(input)).row;
	}

	async createOnce(input: {
		threadId: string;
		provider: string;
		kind?: string;
		providerEventId?: string;
		role: string;
		actor?: string;
		text: string;
		data?: string;
		state?: string;
		createdAt?: number;
	}): Promise<{ row: Message; inserted: boolean }> {
		const existing = input.providerEventId
			? await this.getByProviderEvent(input.provider, input.threadId, input.providerEventId)
			: undefined;
		if (existing) return { row: existing, inserted: false };

		const id = randomUUID();
		const now = input.createdAt ?? Date.now();
		await this.db
			.insert(message)
			.values({
				id,
				threadId: input.threadId,
				provider: input.provider,
				kind: input.kind ?? input.provider,
				providerEventId: input.providerEventId,
				role: input.role,
				actor: input.actor,
				text: input.text,
				data: input.data,
				state: input.state ?? "done",
				createdAt: now,
				updatedAt: now,
			})
			.onConflictDoNothing();
		const row = input.providerEventId
			? await this.getByProviderEvent(input.provider, input.threadId, input.providerEventId)
			: await this.get(id);
		if (!row) throw new Error("message insert failed");
		if (row.id === id) await this.db.update(thread).set({ updatedAt: now }).where(eq(thread.id, input.threadId));
		return { row, inserted: row.id === id };
	}

	async get(id: string): Promise<Message | undefined> {
		const rows = await this.db.select().from(message).where(eq(message.id, id)).limit(1);
		return rows[0];
	}

	async getByProviderEvent(provider: string, threadId: string, eventId: string): Promise<Message | undefined> {
		const rows = await this.db
			.select()
			.from(message)
			.where(
				and(eq(message.provider, provider), eq(message.threadId, threadId), eq(message.providerEventId, eventId)),
			)
			.limit(1);
		return rows[0];
	}

	async listForThread(threadId: string, input?: { limit?: number; excludeId?: string }): Promise<Message[]> {
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

	async listRecent(input: { agent?: string; limit?: number; offset?: number } = {}): Promise<MessageWithThread[]> {
		const filters = [];
		if (input.agent) filters.push(eq(thread.agent, input.agent));
		const query = this.db
			.select({
				id: message.id,
				threadId: message.threadId,
				provider: message.provider,
				kind: message.kind,
				providerEventId: message.providerEventId,
				role: message.role,
				actor: message.actor,
				text: message.text,
				data: message.data,
				state: message.state,
				createdAt: message.createdAt,
				updatedAt: message.updatedAt,
				agent: thread.agent,
				channel: thread.channel,
				threadActor: thread.actor,
			})
			.from(message)
			.innerJoin(thread, eq(message.threadId, thread.id));
		const withFilter = filters.length ? query.where(and(...filters)) : query;
		return await withFilter
			.orderBy(desc(message.createdAt))
			.limit(clampLimit(input.limit, 100, 500))
			.offset(clampOffset(input.offset));
	}

	async search(input: {
		threadId: string;
		query?: string;
		limit?: number;
		before?: number;
		includeTools?: boolean;
	}): Promise<HistoryMessage[]> {
		const limit = clampLimit(input.limit, 20, 100);
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
