import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { sqliteStore } from "../src/store/sqlite.js";

async function tempDb(): Promise<{ path: string; cleanup: () => Promise<void> }> {
	const dir = await mkdtemp(join(tmpdir(), "heypi-history-"));
	return { path: join(dir, "store.db"), cleanup: () => rm(dir, { recursive: true, force: true }) };
}

test("message history search filters, bounds, and excludes tool output by default", async () => {
	const db = await tempDb();
	try {
		const store = sqliteStore({ path: db.path });
		await store.setup();
		const thread = await store.threads.getOrCreate({
			agent: "a",
			provider: "slack",
			channel: "C1",
			actor: "U1",
			key: "C1:T1",
		});
		await store.messages.create({
			threadId: thread.id,
			provider: "slack",
			role: "user",
			actor: "U1",
			text: "alpha deploy failed",
			createdAt: 1000,
		});
		await store.messages.create({
			threadId: thread.id,
			provider: "slack",
			role: "toolResult",
			actor: "heypi",
			text: "alpha secret output",
			createdAt: 1500,
		});
		await store.messages.create({
			threadId: thread.id,
			provider: "slack",
			role: "assistant",
			actor: "heypi",
			text: "alpha deploy fixed",
			createdAt: 2000,
		});

		const rows = await store.messages.search({ threadId: thread.id, query: "alpha", limit: 10 });
		assert.deepEqual(
			rows.map((row) => row.text),
			["alpha deploy failed", "alpha deploy fixed"],
		);

		const bounded = await store.messages.search({ threadId: thread.id, query: "alpha", before: 1800 });
		assert.deepEqual(
			bounded.map((row) => row.text),
			["alpha deploy failed"],
		);

		const withTools = await store.messages.search({ threadId: thread.id, query: "secret", includeTools: true });
		assert.deepEqual(
			withTools.map((row) => row.text),
			["alpha secret output"],
		);
	} finally {
		await db.cleanup();
	}
});
