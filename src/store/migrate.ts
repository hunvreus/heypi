import { createHash } from "node:crypto";
import { sql } from "drizzle-orm";
import type { Db } from "./db.js";
import { MIGRATIONS } from "./migrations.js";

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
