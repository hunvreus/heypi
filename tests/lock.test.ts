import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { CallRunner } from "../src/core/calls.js";
import { createHandler } from "../src/io/handler.js";
import { Queue } from "../src/runtime/queue.js";
import { sqliteStore } from "../src/store/sqlite.js";

async function tempDb(): Promise<{ path: string; cleanup: () => Promise<void> }> {
	const dir = await mkdtemp(join(tmpdir(), "heypi-lock-"));
	return { path: join(dir, "store.db"), cleanup: () => rm(dir, { recursive: true, force: true }) };
}

test("sqlite locks reject concurrent owners and allow release", async () => {
	const db = await tempDb();
	try {
		const store = sqliteStore({ path: db.path });
		await store.setup();
		assert.ok(store.locks);

		const first = await store.locks.acquire({ key: "thread:a", owner: "one" });
		const second = await store.locks.acquire({ key: "thread:a", owner: "two" });
		assert.equal(first?.owner, "one");
		assert.equal(second, undefined);

		await store.locks.release({ key: "thread:a", owner: "one" });
		const third = await store.locks.acquire({ key: "thread:a", owner: "two" });
		assert.equal(third?.owner, "two");
	} finally {
		await db.cleanup();
	}
});

test("sqlite locks can acquire after ttl expiry", async () => {
	const db = await tempDb();
	try {
		const store = sqliteStore({ path: db.path });
		await store.setup();
		assert.ok(store.locks);

		await store.locks.acquire({ key: "thread:a", owner: "one", ttlMs: -1 });
		const next = await store.locks.acquire({ key: "thread:a", owner: "two" });
		assert.equal(next?.owner, "two");
	} finally {
		await db.cleanup();
	}
});

test("handler returns private busy reply when a thread lock is held", async () => {
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
		assert.ok(store.locks);
		await store.locks.acquire({ key: `thread:${thread.id}`, owner: "other" });

		const handler = createHandler({
			agentId: "a",
			store,
			callRunner: new CallRunner(store.calls, store.approvals, new Queue({}), {
				name: "host-bash",
				root: ".",
				capabilities: {},
			}),
			agent: {
				ask: async () => ({ text: "should not run" }),
				continue: async () => ({ text: "should not run" }),
			},
		});

		const out = await handler({
			trace: "trace-1",
			provider: "slack",
			eventId: "event-1",
			channel: "C1",
			actor: "U1",
			thread: "C1:T1",
			text: "deploy",
		});

		assert.equal(out?.private, true);
		assert.match(out?.text ?? "", /already running/);
	} finally {
		await db.cleanup();
	}
});

test("handler returns private thread status", async () => {
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
		const message = await store.messages.create({
			threadId: thread.id,
			provider: "slack",
			role: "user",
			actor: "U1",
			text: "deploy",
		});
		const turn = await store.turns.create({
			threadId: thread.id,
			inputMessageId: message.id,
			agent: "a",
			provider: "slack",
			channel: "C1",
			actor: "U1",
			trace: "trace-1",
		});
		const call = await store.calls.create({
			turnId: turn.id,
			threadId: thread.id,
			messageId: message.id,
			channel: "C1",
			actor: "U1",
			tool: "bash",
			command: "npm test",
			state: "pending_approval",
		});
		await store.approvals.create({
			callId: call.id,
			channel: "C1",
			threadId: thread.id,
			turnId: turn.id,
			requestedBy: "U1",
			command: "npm test",
			runtime: "host-bash",
			reason: "test",
		});

		const handler = createHandler({
			agentId: "a",
			store,
			callRunner: new CallRunner(store.calls, store.approvals, new Queue({}), {
				name: "host-bash",
				root: ".",
				capabilities: {},
			}),
			agent: {
				ask: async () => ({ text: "should not run" }),
				continue: async () => ({ text: "should not run" }),
			},
		});

		const out = await handler({
			trace: "trace-status",
			provider: "slack",
			eventId: "event-status",
			channel: "C1",
			actor: "U1",
			thread: "C1:T1",
			text: "status",
		});

		assert.equal(out?.private, true);
		assert.match(out?.text ?? "", /thread status/);
		assert.match(out?.text ?? "", /active=/);
		assert.match(out?.text ?? "", /pending approvals:/);
		assert.match(out?.text ?? "", /npm test/);
	} finally {
		await db.cleanup();
	}
});
