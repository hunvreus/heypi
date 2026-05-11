import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { thread } from "../db/schema.js";
import type { Db } from "./db.js";

export type ThreadRow = typeof thread.$inferSelect;

export class ThreadRepo {
	constructor(private readonly db: Db) {}

	async getOrCreate(input: {
		agent: string;
		provider: string;
		channel: string;
		actor?: string;
		key: string;
	}): Promise<ThreadRow> {
		const found = await this.getByKey(input.agent, input.provider, input.key);
		if (found) return found;

		const id = randomUUID();
		const now = Date.now();
		await this.db.insert(thread).values({
			id,
			agent: input.agent,
			provider: input.provider,
			channel: input.channel,
			actor: input.actor,
			key: input.key,
			createdAt: now,
			updatedAt: now,
		});
		const row = await this.getByKey(input.agent, input.provider, input.key);
		if (!row) throw new Error("thread insert failed");
		return row;
	}

	async getByKey(agent: string, provider: string, key: string): Promise<ThreadRow | undefined> {
		const rows = await this.db
			.select()
			.from(thread)
			.where(and(eq(thread.agent, agent), eq(thread.provider, provider), eq(thread.key, key)))
			.limit(1);
		return rows[0];
	}
}
