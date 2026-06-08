import type { SessionEntry } from "@earendil-works/pi-coding-agent";
import { eq } from "drizzle-orm";
import { sessionBlob } from "../db/schema.js";
import type { Db } from "./db.js";
import type { Sessions } from "./types.js";

/** libSQL-backed session transcript store. Captures the entry tree as a JSON blob per session. */
export class SessionRepo implements Sessions {
	constructor(private readonly db: Db) {}

	async load(sessionId: string): Promise<SessionEntry[] | null> {
		const rows = await this.db
			.select({ entries: sessionBlob.entries })
			.from(sessionBlob)
			.where(eq(sessionBlob.sessionId, sessionId))
			.limit(1);
		const row = rows[0];
		if (!row) return null;
		return JSON.parse(row.entries) as SessionEntry[];
	}

	async save(sessionId: string, entries: SessionEntry[]): Promise<void> {
		const now = Date.now();
		const payload = JSON.stringify(entries);
		await this.db
			.insert(sessionBlob)
			.values({ sessionId, entries: payload, updatedAt: now })
			.onConflictDoUpdate({ target: sessionBlob.sessionId, set: { entries: payload, updatedAt: now } });
	}
}
