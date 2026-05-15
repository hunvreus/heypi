import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { sql } from "drizzle-orm";
import { openDb } from "../src/store/db.js";
import { migrate } from "../src/store/migrate.js";

test("migrate records applied heypi migrations and can run twice", async () => {
	const root = await mkdtemp(join(tmpdir(), "heypi-migrate-"));
	try {
		const db = openDb({ url: `file:${join(root, "heypi.db")}` });
		await migrate(db);
		await migrate(db);

		const rows = await db.all<{ count: number }>(sql.raw("SELECT count(*) as count FROM __heypi_migration"));
		assert.ok(Number(rows[0]?.count) >= 1);
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});
