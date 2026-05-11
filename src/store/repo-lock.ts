import { and, eq, lte } from "drizzle-orm";
import { lock } from "../db/schema.js";
import type { Db } from "./db.js";
import type { Lock } from "./types.js";

const DEFAULT_TTL_MS = 60 * 60 * 1000;

export type LockRow = typeof lock.$inferSelect;

export class LockRepo {
	constructor(private readonly db: Db) {}

	async acquire(input: { key: string; owner: string; ttlMs?: number }): Promise<Lock | undefined> {
		const now = Date.now();
		await this.db.delete(lock).where(lte(lock.expiresAt, now));
		await this.db
			.insert(lock)
			.values({
				key: input.key,
				owner: input.owner,
				expiresAt: now + (input.ttlMs ?? DEFAULT_TTL_MS),
				createdAt: now,
				updatedAt: now,
			})
			.onConflictDoNothing();
		return this.getOwned(input.key, input.owner);
	}

	async release(input: { key: string; owner: string }): Promise<void> {
		await this.db.delete(lock).where(and(eq(lock.key, input.key), eq(lock.owner, input.owner)));
	}

	async get(key: string): Promise<Lock | undefined> {
		const rows = await this.db.select().from(lock).where(eq(lock.key, key)).limit(1);
		return rows[0];
	}

	private async getOwned(key: string, owner: string): Promise<Lock | undefined> {
		const row = await this.get(key);
		return row?.owner === owner ? row : undefined;
	}
}
