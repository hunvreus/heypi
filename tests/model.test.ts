import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { CallRunner } from "../src/core/calls.js";
import { createHandler } from "../src/io/handler.js";
import type { ReplyStream } from "../src/io/reply-stream.js";
import type { AgentReq } from "../src/runtime/agent.js";
import { streamTextDelta } from "../src/runtime/pi-agent.js";
import { Queue } from "../src/runtime/queue.js";
import { sqliteStore } from "../src/store/sqlite.js";

async function tempDb(): Promise<{ path: string; cleanup: () => Promise<void> }> {
	const dir = await mkdtemp(join(tmpdir(), "heypi-model-"));
	return { path: join(dir, "store.db"), cleanup: () => rm(dir, { recursive: true, force: true }) };
}

test("handler passes per-turn model override to agent", async () => {
	const db = await tempDb();
	try {
		const store = sqliteStore({ path: db.path });
		await store.setup();
		let request: AgentReq | undefined;
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
					request = req;
					return { text: "ok" };
				},
				continue: async () => ({ text: "ok" }),
			},
		});

		await handler({
			trace: "trace-1",
			provider: "test",
			eventId: "event-1",
			channel: "C1",
			actor: "U1",
			thread: "T1",
			text: "hello",
			model: { provider: "openai", name: "gpt-5.5" },
		});

		assert.deepEqual(request?.model, { provider: "openai", name: "gpt-5.5" });
	} finally {
		await db.cleanup();
	}
});

test("handler redacts secrets before returning adapter output", async () => {
	const db = await tempDb();
	try {
		const store = sqliteStore({ path: db.path });
		await store.setup();
		const handler = createHandler({
			agentId: "a",
			store,
			callRunner: new CallRunner(store.calls, store.approvals, new Queue({}), {
				name: "host-bash",
				root: ".",
				capabilities: {},
			}),
			agent: {
				ask: async () => ({ text: "token sk-testsecret" }),
				continue: async () => ({ text: "ok" }),
			},
		});

		const out = await handler({
			trace: "trace-1",
			provider: "test",
			eventId: "event-redact",
			channel: "C1",
			actor: "U1",
			thread: "T1",
			text: "hello",
		});

		assert.equal(out?.text, "token sk-<redacted>");
	} finally {
		await db.cleanup();
	}
});

test("handler keeps streamed output redacted", async () => {
	const db = await tempDb();
	try {
		const store = sqliteStore({ path: db.path });
		await store.setup();
		const events: string[] = [];
		const stream: ReplyStream = {
			update: async (text) => {
				events.push(`update:${text}`);
			},
			finalize: async (text) => {
				events.push(`finalize:${text}`);
			},
			stop: async () => undefined,
		};
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
					await req.stream?.update("token sk-<redacted>");
					return { text: "token sk-testsecret" };
				},
				continue: async () => ({ text: "ok" }),
			},
		});

		const out = await handler({
			trace: "trace-1",
			provider: "test",
			eventId: "event-stream-redact",
			channel: "C1",
			actor: "U1",
			thread: "T1",
			text: "hello",
			stream,
		});

		assert.deepEqual(events, ["update:token sk-<redacted>", "finalize:token sk-<redacted>"]);
		assert.equal(out?.text, "token sk-<redacted>");
	} finally {
		await db.cleanup();
	}
});

test("PiAgent stream delta helper redacts before updating streams", async () => {
	const updates: string[] = [];
	let resolveUpdate!: () => void;
	const updated = new Promise<void>((resolve) => {
		resolveUpdate = resolve;
	});
	const stream: ReplyStream = {
		update: async (text) => {
			updates.push(text);
			resolveUpdate();
		},
		finalize: async () => undefined,
		stop: async () => undefined,
	};

	const out = streamTextDelta({
		current: "token ",
		delta: "sk-secret",
		stream,
		logger: { warn() {} },
		context: {},
	});

	await updated;
	assert.equal(out, "token sk-secret");
	assert.deepEqual(updates, ["token sk-<redacted>"]);
});

test("handler suppresses silent replies for inbound chat messages", async () => {
	const db = await tempDb();
	try {
		const store = sqliteStore({ path: db.path });
		await store.setup();
		const handler = createHandler({
			agentId: "a",
			store,
			callRunner: new CallRunner(store.calls, store.approvals, new Queue({}), {
				name: "host-bash",
				root: ".",
				capabilities: {},
			}),
			agent: {
				ask: async () => ({ text: "", silent: true }),
				continue: async () => ({ text: "ok" }),
			},
		});

		const out = await handler({
			trace: "trace-1",
			provider: "test",
			eventId: "event-silent",
			channel: "C1",
			actor: "U1",
			thread: "T1",
			text: "hello",
		});

		assert.equal(out, undefined);
	} finally {
		await db.cleanup();
	}
});

test("handler keeps silent replies visible to scheduled callers", async () => {
	const db = await tempDb();
	try {
		const store = sqliteStore({ path: db.path });
		await store.setup();
		const handler = createHandler({
			agentId: "a",
			store,
			callRunner: new CallRunner(store.calls, store.approvals, new Queue({}), {
				name: "host-bash",
				root: ".",
				capabilities: {},
			}),
			agent: {
				ask: async () => ({ text: "", silent: true }),
				continue: async () => ({ text: "ok" }),
			},
		});

		const out = await handler({
			trace: "trace-1",
			provider: "test",
			eventId: "event-scheduled-silent",
			channel: "C1",
			actor: "heypi",
			thread: "T1",
			text: "hello",
			scheduled: true,
			data: { job: "daily" },
		});

		assert.deepEqual(out, { text: "", silent: true });
	} finally {
		await db.cleanup();
	}
});

test("handler finalizes normal streams and stops streams for approvals", async () => {
	const db = await tempDb();
	try {
		const store = sqliteStore({ path: db.path });
		await store.setup();
		const events: string[] = [];
		const stream: ReplyStream = {
			update: async (text) => {
				events.push(`update:${text}`);
			},
			finalize: async (text) => {
				events.push(`finalize:${text}`);
			},
			stop: async () => {
				events.push("stop");
			},
		};
		const handler = createHandler({
			agentId: "a",
			store,
			callRunner: new CallRunner(store.calls, store.approvals, new Queue({}), {
				name: "host-bash",
				root: ".",
				capabilities: {},
			}),
			agent: {
				ask: async (req) =>
					req.text.includes("approval")
						? {
								text: "approval needed",
								approval: {
									id: "approval-1",
									callId: "call-1",
									command: "tool",
									runtime: "tool",
									reason: "confirm",
									allowed: [],
								},
							}
						: { text: "done" },
				continue: async () => ({ text: "ok" }),
			},
		});

		await handler({
			trace: "trace-1",
			provider: "test",
			eventId: "event-stream-normal",
			channel: "C1",
			actor: "U1",
			thread: "T1",
			text: "hello",
			stream,
		});
		await handler({
			trace: "trace-2",
			provider: "test",
			eventId: "event-stream-approval",
			channel: "C1",
			actor: "U1",
			thread: "T1",
			text: "approval please",
			stream,
		});

		assert.deepEqual(events, ["finalize:done", "stop"]);
	} finally {
		await db.cleanup();
	}
});
