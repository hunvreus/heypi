import { randomUUID } from "node:crypto";
import { and, desc, eq, inArray } from "drizzle-orm";
import { thread } from "../db/schema.js";
import type { Db } from "./db.js";

export type ThreadRow = typeof thread.$inferSelect;

export class ThreadRepo {
	constructor(private readonly db: Db) {}

	async getOrCreate(input: {
		agent: string;
		provider: string;
		kind?: string;
		team?: string;
		channel: string;
		actor?: string;
		key: string;
	}): Promise<ThreadRow> {
		const team = input.team ?? "";
		const found = await this.getByKey(input.agent, input.provider, team, input.key);
		if (found) return found;

		const id = randomUUID();
		const sessionId = randomUUID();
		const now = Date.now();
		await this.db
			.insert(thread)
			.values({
				id,
				agent: input.agent,
				provider: input.provider,
				kind: input.kind ?? input.provider,
				team,
				channel: input.channel,
				actor: input.actor,
				key: input.key,
				sessionId,
				sessionPath: `sessions/${sessionId}.jsonl`,
				createdAt: now,
				updatedAt: now,
			})
			.onConflictDoNothing();
		const row = await this.getByKey(input.agent, input.provider, team, input.key);
		if (!row) throw new Error("thread insert failed");
		return row;
	}

	async list(
		input: {
			agent?: string;
			providers?: string[];
			teams?: string[];
			channels?: string[];
			users?: string[];
			limit?: number;
			offset?: number;
		} = {},
	): Promise<ThreadRow[]> {
		const filters = [];
		if (input.agent) filters.push(eq(thread.agent, input.agent));
		if (input.providers?.length) filters.push(inArray(thread.provider, input.providers));
		if (input.teams?.length) filters.push(inArray(thread.team, input.teams));
		if (input.channels?.length) filters.push(inArray(thread.channel, input.channels));
		if (input.users?.length) filters.push(inArray(thread.actor, input.users));
		const query = this.db.select().from(thread);
		const withFilter = filters.length ? query.where(and(...filters)) : query;
		return await withFilter
			.orderBy(desc(thread.updatedAt))
			.limit(Math.min(Math.max(input.limit ?? 100, 1), 1000))
			.offset(Math.max(input.offset ?? 0, 0));
	}

	async getByKey(
		agent: string,
		provider: string,
		team: string | undefined,
		key: string,
	): Promise<ThreadRow | undefined> {
		const rows = await this.db
			.select()
			.from(thread)
			.where(
				and(
					eq(thread.agent, agent),
					eq(thread.provider, provider),
					eq(thread.team, team ?? ""),
					eq(thread.key, key),
				),
			)
			.limit(1);
		return rows[0];
	}

	async get(id: string): Promise<ThreadRow | undefined> {
		const rows = await this.db.select().from(thread).where(eq(thread.id, id)).limit(1);
		return rows[0];
	}
}
