import { and, eq, lte, sql } from "drizzle-orm";
import { lock } from "../db/schema.js";
import type { Db } from "./db.js";
import type { Lock } from "./types.js";

const DEFAULT_TTL_MS = 60 * 60 * 1000;

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

	async refresh(input: { key: string; owner: string; ttlMs?: number }): Promise<Lock | undefined> {
		const now = Date.now();
		await this.db
			.update(lock)
			.set({ expiresAt: now + (input.ttlMs ?? DEFAULT_TTL_MS), updatedAt: now })
			.where(and(eq(lock.key, input.key), eq(lock.owner, input.owner)));
		return this.getOwned(input.key, input.owner);
	}

	async clear(input: { key?: string; prefix?: string } = {}): Promise<number> {
		const rows = input.key
			? await this.db.delete(lock).where(eq(lock.key, input.key)).returning({ key: lock.key })
			: input.prefix
				? await this.db
						.delete(lock)
						.where(sql`${lock.key} LIKE ${`${escapeLike(input.prefix)}%`} ESCAPE '\\'`)
						.returning({ key: lock.key })
				: await this.db.delete(lock).returning({ key: lock.key });
		return rows.length;
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

function escapeLike(input: string): string {
	return input.replaceAll("\\", "\\\\").replaceAll("%", "\\%").replaceAll("_", "\\_");
}
