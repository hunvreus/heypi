import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { CallRunner } from "../src/core/calls.js";
import { normalizeMessages } from "../src/core/messages.js";
import { createHandler } from "../src/io/handler.js";
import { Queue } from "../src/runtime/queue.js";
import { sqliteStore } from "../src/store/sqlite.js";

async function tempDb(): Promise<{ path: string; cleanup: () => Promise<void> }> {
	const dir = await mkdtemp(join(tmpdir(), "heypi-lock-"));
	return { path: join(dir, "store.db"), cleanup: () => rm(dir, { recursive: true, force: true }) };
}

async function aborted(signal?: AbortSignal): Promise<void> {
	if (!signal) return;
	if (signal?.aborted) return;
	await new Promise<void>((resolve) => signal?.addEventListener("abort", () => resolve(), { once: true }));
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

test("sqlite locks can refresh ownership", async () => {
	const db = await tempDb();
	try {
		const store = sqliteStore({ path: db.path });
		await store.setup();
		assert.ok(store.locks);

		const first = await store.locks.acquire({ key: "app:a", owner: "one", ttlMs: 10 });
		assert.ok(first);
		await new Promise((resolve) => setTimeout(resolve, 5));
		const refreshed = await store.locks.refresh({ key: "app:a", owner: "one", ttlMs: 60_000 });
		const wrongOwner = await store.locks.refresh({ key: "app:a", owner: "two", ttlMs: 60_000 });

		assert.equal(refreshed?.owner, "one");
		assert.equal(wrongOwner, undefined);
		assert.ok((refreshed?.expiresAt ?? 0) > first.expiresAt);
	} finally {
		await db.cleanup();
	}
});

test("sqlite locks can clear by prefix", async () => {
	const db = await tempDb();
	try {
		const store = sqliteStore({ path: db.path });
		await store.setup();
		assert.ok(store.locks);

		await store.locks.acquire({ key: "thread:a", owner: "one" });
		await store.locks.acquire({ key: "job:a", owner: "two" });
		assert.equal(await store.locks.clear?.({ prefix: "thread:" }), 1);
		assert.equal(await store.locks.get("thread:a"), undefined);
		assert.equal((await store.locks.get("job:a"))?.owner, "two");

		await store.locks.acquire({ key: "thread_%:a", owner: "three" });
		await store.locks.acquire({ key: "thread_x:a", owner: "four" });
		assert.equal(await store.locks.clear?.({ prefix: "thread_%:" }), 1);
		assert.equal(await store.locks.get("thread_%:a"), undefined);
		assert.equal((await store.locks.get("thread_x:a"))?.owner, "four");
	} finally {
		await db.cleanup();
	}
});

test("sqlite locks can clear one exact key", async () => {
	const db = await tempDb();
	try {
		const store = sqliteStore({ path: db.path });
		await store.setup();
		assert.ok(store.locks);
		await store.locks.acquire({ key: "thread:a", owner: "one" });
		await store.locks.acquire({ key: "thread:ab", owner: "two" });

		assert.equal(await store.locks.clear?.({ key: "thread:a" }), 1);
		assert.equal(await store.locks.get("thread:a"), undefined);
		assert.equal((await store.locks.get("thread:ab"))?.owner, "two");
	} finally {
		await db.cleanup();
	}
});

test("handler returns public busy reply when a thread lock is held without an active run", async () => {
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
			messages: normalizeMessages({ busyReject: "Thread is busy." }),
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

		assert.equal(out?.private, undefined);
		assert.equal(out?.finalPlacement, "thread");
		assert.equal(out?.text, "Thread is busy.");
	} finally {
		await db.cleanup();
	}
});

test("handler steers same-thread asks into the active run by default", async () => {
	const db = await tempDb();
	try {
		const store = sqliteStore({ path: db.path });
		await store.setup();
		let release!: () => void;
		let sessionReady!: () => void;
		const gate = new Promise<void>((resolve) => {
			release = resolve;
		});
		const ready = new Promise<void>((resolve) => {
			sessionReady = resolve;
		});
		const steered: string[] = [];
		const handler = createHandler({
			agentId: "a",
			store,
			callRunner: new CallRunner(store.calls, store.approvals, new Queue({}), {
				name: "host-bash",
				root: ".",
				capabilities: {},
			}),
			agent: {
				ask: async (req) => {
					req.onLiveSession?.({
						steer: async (text) => {
							steered.push(text);
						},
						followUp: async () => undefined,
					});
					sessionReady();
					await gate;
					return { text: "done" };
				},
				continue: async () => ({ text: "should not run" }),
			},
		});

		const first = handler({
			trace: "trace-1",
			provider: "slack",
			eventId: "event-1",
			channel: "C1",
			actor: "U1",
			thread: "C1:T1",
			text: "deploy",
		});
		await ready;
		const second = await handler({
			trace: "trace-2",
			provider: "slack",
			eventId: "event-2",
			channel: "C1",
			actor: "U2",
			actorName: "Jane",
			thread: "C1:T1",
			text: "also check nginx",
		});
		release();
		const firstOut = await first;

		assert.equal(second?.text, "Got it. I'll include that.");
		assert.equal(second?.finalPlacement, "thread");
		assert.deepEqual(steered, ["[Message from Jane (U2)]\nalso check nginx"]);
		assert.equal(firstOut?.finalPlacement, "thread");
	} finally {
		await db.cleanup();
	}
});

test("handler lets only the run initiator cancel when no approvers are configured", async () => {
	const db = await tempDb();
	try {
		const store = sqliteStore({ path: db.path });
		await store.setup();
		let signal: AbortSignal | undefined;
		let ready!: () => void;
		const started = new Promise<void>((resolve) => {
			ready = resolve;
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
				ask: async (req) => {
					signal = req.signal;
					ready();
					await aborted(req.signal);
					return { text: "done" };
				},
				continue: async () => ({ text: "should not run" }),
			},
		});

		const first = handler({
			trace: "trace-1",
			provider: "slack",
			eventId: "event-1",
			channel: "C1",
			actor: "U_REQUESTER",
			thread: "C1:T1",
			text: "deploy",
		});
		await started;

		const rejected = await handler({
			trace: "trace-cancel-other",
			provider: "slack",
			eventId: "event-cancel-other",
			channel: "C1",
			actor: "U_OTHER",
			thread: "C1:T1",
			text: "cancel trace-1",
		});
		assert.equal(rejected?.private, true);
		assert.match(rejected?.text ?? "", /not allowed/i);
		assert.equal(signal?.aborted, false);

		const cancelled = await handler({
			trace: "trace-cancel-owner",
			provider: "slack",
			eventId: "event-cancel-owner",
			channel: "C1",
			actor: "U_REQUESTER",
			thread: "C1:T1",
			text: "cancel trace-1",
		});
		const firstOut = await first;

		assert.equal(cancelled?.text, "Cancelled.");
		assert.equal(signal?.aborted, true);
		assert.match(firstOut?.text ?? "", /cancelled/i);
	} finally {
		await db.cleanup();
	}
});

test("handler lets configured approvers cancel another actor's run", async () => {
	const db = await tempDb();
	try {
		const store = sqliteStore({ path: db.path });
		await store.setup();
		let ready!: () => void;
		const started = new Promise<void>((resolve) => {
			ready = resolve;
		});
		const handler = createHandler({
			agentId: "a",
			store,
			approval: { approvers: ["U_APPROVER"] },
			callRunner: new CallRunner(store.calls, store.approvals, new Queue({}), {
				name: "host-bash",
				root: ".",
				capabilities: {},
			}),
			agent: {
				ask: async (req) => {
					ready();
					await aborted(req.signal);
					return { text: "done" };
				},
				continue: async () => ({ text: "should not run" }),
			},
		});

		const first = handler({
			trace: "trace-approver-run",
			provider: "slack",
			eventId: "event-approver-run",
			channel: "C1",
			actor: "U_REQUESTER",
			thread: "C1:T1",
			text: "deploy",
		});
		await started;

		const cancelled = await handler({
			trace: "trace-cancel-approver",
			provider: "slack",
			eventId: "event-cancel-approver",
			channel: "C1",
			actor: "U_APPROVER",
			thread: "C1:T1",
			text: "cancel trace-approver-run",
		});
		const firstOut = await first;

		assert.equal(cancelled?.text, "Cancelled.");
		assert.match(firstOut?.text ?? "", /cancelled/i);
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
			agent: "a",
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
			agent: "a",
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
		assert.match(out?.text ?? "", /Thread status/);
		assert.match(out?.text ?? "", /Active:/);
		assert.match(out?.text ?? "", /Pending approvals:/);
		assert.match(out?.text ?? "", /npm test/);
	} finally {
		await db.cleanup();
	}
});

test("thread status explains an active turn without claiming nothing needs action", async () => {
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
		await store.turns.create({
			threadId: thread.id,
			inputMessageId: message.id,
			agent: "a",
			provider: "slack",
			channel: "C1",
			actor: "U1",
			trace: "trace-1",
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

		assert.match(out?.text ?? "", /Active: `running`/);
		assert.match(out?.text ?? "", /Current activity:/);
		assert.doesNotMatch(out?.text ?? "", /Nothing needs action/);
	} finally {
		await db.cleanup();
	}
});

test("thread status does not list stale blocked calls as needing attention", async () => {
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
		await store.calls.create({
			agent: "a",
			turnId: turn.id,
			threadId: thread.id,
			messageId: message.id,
			channel: "C1",
			actor: "U1",
			tool: "host_exec",
			state: "blocked",
		});
		await store.turns.finish(turn.id, { state: "done" });

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

		assert.doesNotMatch(out?.text ?? "", /Calls needing attention/);
		assert.match(out?.text ?? "", /Nothing needs action/);
	} finally {
		await db.cleanup();
	}
});
