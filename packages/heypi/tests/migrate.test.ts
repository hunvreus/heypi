import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { sql } from "drizzle-orm";
import { openDb } from "../src/store/db.js";
import { migrate } from "../src/store/migrate.js";
import { MIGRATIONS } from "../src/store/migrations.js";

test("migrate records applied heypi migrations and can run twice", async () => {
	const root = await mkdtemp(join(tmpdir(), "heypi-migrate-"));
	try {
		const db = openDb({ url: `file:${join(root, "heypi.db")}` });
		await migrate(db);
		await migrate(db);

		const rows = await db.all<{ name: string }>(sql.raw("SELECT name FROM __heypi_migration ORDER BY name"));
		assert.deepEqual(
			rows.map((row) => row.name),
			MIGRATIONS.map((migration) => migration.name),
		);
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});

test("migrate creates the current baseline schema", async () => {
	const root = await mkdtemp(join(tmpdir(), "heypi-migrate-schema-"));
	try {
		const db = openDb({ url: `file:${join(root, "heypi.db")}` });
		await migrate(db);

		assert.deepEqual(await columns(db, "call"), [
			"id",
			"agent",
			"turn_id",
			"thread_id",
			"message_id",
			"channel",
			"actor",
			"tool",
			"tool_call_id",
			"command",
			"args",
			"runtime",
			"policy_reason",
			"state",
			"code",
			"out",
			"err",
			"ms",
			"queue_wait_ms",
			"created_at",
			"updated_at",
			"err_kind",
		]);
		assert.deepEqual(await columns(db, "approval"), [
			"id",
			"agent",
			"call_id",
			"channel",
			"thread_id",
			"turn_id",
			"request_message_id",
			"command",
			"runtime",
			"reason",
			"details",
			"state",
			"requested_by",
			"requested_at",
			"expires_at",
			"resolved_at",
			"resolved_by",
		]);
		assert.deepEqual(await columns(db, "job_run"), [
			"id",
			"job_agent",
			"job_id",
			"thread_id",
			"trace",
			"state",
			"output",
			"error",
			"delivery_state",
			"started_at",
			"ended_at",
		]);
		assert.ok((await indexes(db, "lock")).includes("lock_expires_idx"));
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});

async function columns(db: ReturnType<typeof openDb>, table: string): Promise<string[]> {
	const rows = await db.all<{ name: string }>(sql.raw(`PRAGMA table_info(${JSON.stringify(table)})`));
	return rows.map((row) => row.name);
}

async function indexes(db: ReturnType<typeof openDb>, table: string): Promise<string[]> {
	const rows = await db.all<{ name: string }>(sql.raw(`PRAGMA index_list(${JSON.stringify(table)})`));
	return rows.map((row) => row.name);
}
