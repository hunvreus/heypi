import { createHash } from "node:crypto";
import { sql } from "drizzle-orm";
import type { Db } from "./db.js";
import { MIGRATIONS } from "./migrations.js";

export type MigrationStatus =
	| { state: "ok"; applied: number; pending: string[] }
	| { state: "pending"; applied: number; pending: string[] }
	| { state: "changed"; applied: number; pending: string[]; changed: string };

export async function migrate(db: Db): Promise<void> {
	await db.run(
		sql.raw(
			"CREATE TABLE IF NOT EXISTS __heypi_migration (name text PRIMARY KEY NOT NULL, hash text NOT NULL, applied_at integer NOT NULL)",
		),
	);
	for (const { name, content } of MIGRATIONS) {
		const hash = createHash("sha256").update(content).digest("hex");
		const existing = await db.all<{ hash: string }>(sql`SELECT hash FROM __heypi_migration WHERE name = ${name}`);
		if (existing[0]?.hash === hash) continue;
		if (existing[0]) throw new Error(`heypi migration changed after apply: ${name}`);
		const parts = content
			.split("--> statement-breakpoint")
			.map((v) => v.trim())
			.filter(Boolean);
		for (const stmt of parts) await db.run(sql.raw(stmt));
		await db.run(sql`
			INSERT INTO __heypi_migration (name, hash, applied_at)
			VALUES (${name}, ${hash}, ${Date.now()})
			ON CONFLICT(name) DO UPDATE SET hash = excluded.hash, applied_at = excluded.applied_at
		`);
	}
}

export async function migrationStatus(db: Db): Promise<MigrationStatus> {
	const table = await db.all<{ name: string }>(
		sql.raw("SELECT name FROM sqlite_master WHERE type = 'table' AND name = '__heypi_migration'"),
	);
	if (!table[0]) return { state: "pending", applied: 0, pending: MIGRATIONS.map((migration) => migration.name) };
	const rows = await db.all<{ name: string; hash: string }>(
		sql.raw("SELECT name, hash FROM __heypi_migration ORDER BY name"),
	);
	const applied = new Map(rows.map((row) => [row.name, row.hash]));
	const pending: string[] = [];
	for (const { name, content } of MIGRATIONS) {
		const hash = createHash("sha256").update(content).digest("hex");
		const existing = applied.get(name);
		if (existing === hash) continue;
		if (existing) return { state: "changed", applied: rows.length, pending, changed: name };
		pending.push(name);
	}
	return pending.length
		? { state: "pending", applied: rows.length, pending }
		: { state: "ok", applied: rows.length, pending };
}
