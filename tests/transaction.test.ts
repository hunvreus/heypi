import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { sqliteStore } from "../src/store/sqlite.js";

test("sqlite store transaction rolls back repo writes on failure", async () => {
	const root = await mkdtemp(join(tmpdir(), "heypi-transaction-"));
	try {
		const store = sqliteStore({ path: join(root, "heypi.db") });
		await store.setup();
		const thread = await store.threads.getOrCreate({
			agent: "a",
			provider: "test",
			channel: "c",
			key: "c:c",
		});

		await assert.rejects(
			() =>
				store.transaction!(async (tx) => {
					await tx.messages.create({
						threadId: thread.id,
						provider: "test",
						role: "user",
						text: "rolled back",
						state: "done",
					});
					throw new Error("rollback");
				}),
			/rollback/,
		);

		const rows = await store.messages.listForThread(thread.id);
		assert.equal(rows.length, 0);
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});

test("sqlite approval resolve reports one winner per pending approval", async () => {
	const root = await mkdtemp(join(tmpdir(), "heypi-approval-resolve-"));
	try {
		const store = sqliteStore({ path: join(root, "heypi.db") });
		await store.setup();
		const approval = await store.approvals.create({
			agent: "a",
			callId: "call-1",
			channel: "slack::C1",
			command: "npm test",
			runtime: "host-bash",
			reason: "Run tests.",
		});
		const realNow = Date.now;
		Date.now = () => 1234567890;
		try {
			assert.equal(await store.approvals.resolve(approval.id, "approved", "U1", { agent: "a" }), true);
			assert.equal(await store.approvals.resolve(approval.id, "approved", "U1", { agent: "a" }), false);
		} finally {
			Date.now = realNow;
		}
		const row = await store.approvals.get(approval.id, { agent: "a" });
		assert.equal(row?.state, "approved");
		assert.equal(row?.resolvedBy, "U1");
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});

test("sqlite store rejects nested transactions", async () => {
	const root = await mkdtemp(join(tmpdir(), "heypi-transaction-nested-"));
	try {
		const store = sqliteStore({ path: join(root, "heypi.db") });
		await store.setup();

		await assert.rejects(
			() =>
				store.transaction!(async (tx) => {
					await tx.transaction!(async () => undefined);
				}),
			/nested store transactions are not supported/,
		);
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});
