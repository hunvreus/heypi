import type { SessionEntry } from "@hunvreus/heypi/runtime";
import type { Sessions } from "@hunvreus/heypi/store";

/**
 * A heypi SessionStore backed by a Durable Object's embedded SQLite (ctx.storage.sql).
 *
 * Each ThreadAgent instance owns one of these, so a thread's transcript lives co-located with
 * the object that processes its turns — no external database round-trip for session state.
 */
export class DurableSessions implements Sessions {
	constructor(private readonly sql: SqlStorage) {
		this.sql.exec(
			"CREATE TABLE IF NOT EXISTS session_blob (session_id TEXT PRIMARY KEY, entries TEXT NOT NULL, updated_at INTEGER NOT NULL)",
		);
	}

	async load(sessionId: string): Promise<SessionEntry[] | null> {
		const rows = this.sql
			.exec<{ entries: string }>("SELECT entries FROM session_blob WHERE session_id = ?", sessionId)
			.toArray();
		return rows.length ? (JSON.parse(rows[0].entries) as SessionEntry[]) : null;
	}

	async save(sessionId: string, entries: SessionEntry[]): Promise<void> {
		this.sql.exec(
			"INSERT INTO session_blob (session_id, entries, updated_at) VALUES (?, ?, ?) ON CONFLICT(session_id) DO UPDATE SET entries = excluded.entries, updated_at = excluded.updated_at",
			sessionId,
			JSON.stringify(entries),
			Date.now(),
		);
	}
}
