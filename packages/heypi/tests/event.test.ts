import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { CallRunner } from "../src/core/calls.js";
import type { Logger } from "../src/core/log.js";
import { createHandler } from "../src/io/handler.js";
import type { Agent } from "../src/runtime/agent.js";
import { Queue } from "../src/runtime/queue.js";
import { sqliteStore } from "../src/store/sqlite.js";

const logger: Logger = {
	debug: () => undefined,
	info: () => undefined,
	warn: () => undefined,
	error: () => undefined,
};

test("event repo appends monotonic per-trace events", async () => {
	const root = await mkdtemp(join(tmpdir(), "heypi-event-"));
	try {
		const store = sqliteStore({ path: join(root, "heypi.db") });
		await store.setup();
		const first = await store.events!.append({
			agent: "a",
			trace: "trace-1",
			type: "turn.started",
			threadId: "thread-1",
			turnId: "turn-1",
			data: { state: "running" },
			createdAt: 10,
		});
		const second = await store.events!.append({
			agent: "a",
			trace: "trace-1",
			type: "turn.completed",
			threadId: "thread-1",
			turnId: "turn-1",
			data: { state: "done" },
			createdAt: 20,
		});
		const other = await store.events!.append({
			agent: "a",
			trace: "trace-2",
			type: "turn.started",
			threadId: "thread-2",
		});

		assert.equal(first.seq, 0);
		assert.equal(second.seq, 1);
		assert.equal(other.seq, 0);
		assert.equal(first.data, '{"state":"running"}');
		assert.deepEqual(
			(await store.events!.list({ trace: "trace-1" })).map((row) => [row.type, row.seq]),
			[
				["turn.completed", 1],
				["turn.started", 0],
			],
		);
		assert.deepEqual(
			(await store.events!.list({ threadId: "thread-2" })).map((row) => row.trace),
			["trace-2"],
		);
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});

test("event repo redacts secrets in event data centrally", async () => {
	const root = await mkdtemp(join(tmpdir(), "heypi-event-redact-"));
	try {
		const store = sqliteStore({ path: join(root, "heypi.db") });
		await store.setup();
		const row = await store.events!.append({
			agent: "a",
			trace: "trace-secret",
			type: "tool.completed",
			data: {
				token: "sk-testsecret1234567890",
				nested: {
					value: "Authorization xoxb-secret-token",
					list: ["ghp_secretsecretsecret", "safe"],
				},
			},
		});

		assert.doesNotMatch(row.data, /sk-testsecret/);
		assert.doesNotMatch(row.data, /xoxb-secret-token/);
		assert.doesNotMatch(row.data, /ghp_secretsecretsecret/);
		assert.match(row.data, /sk-<redacted>/);
		assert.match(row.data, /xoxb-<redacted>/);
		assert.match(row.data, /ghp_<redacted>/);
		assert.match(row.data, /safe/);
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});

test("handler emits message and turn timeline events", async () => {
	const root = await mkdtemp(join(tmpdir(), "heypi-handler-event-"));
	try {
		const store = sqliteStore({ path: join(root, "heypi.db") });
		await store.setup();
		const agent: Agent = {
			ask: async () => ({ text: "pong" }),
			continue: async () => ({ text: "continued" }),
		};
		const callRunner = new CallRunner(
			store.calls,
			store.approvals,
			new Queue({ maxConcurrent: 1, maxPerChat: 1 }),
			{ name: "test", root },
			{},
			logger,
			store.transaction,
			undefined,
			undefined,
			"a",
			store.approvalBypasses,
			store.events,
		);
		const handler = createHandler({ agentId: "a", store, callRunner, agent, logger });
		const out = await handler({
			trace: "trace-1",
			provider: "local",
			channel: "C1",
			actor: "U1",
			thread: "T1",
			text: "ping",
		});

		assert.equal(out?.text, "pong");
		assert.deepEqual((await store.events!.list({ trace: "trace-1" })).map((row) => row.type).reverse(), [
			"message.received",
			"turn.started",
			"message.sent",
			"turn.completed",
		]);
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});

test("call runner emits tool timeline events", async () => {
	const root = await mkdtemp(join(tmpdir(), "heypi-call-event-"));
	try {
		const store = sqliteStore({ path: join(root, "heypi.db") });
		await store.setup();
		const callRunner = new CallRunner(
			store.calls,
			store.approvals,
			new Queue({ maxConcurrent: 1, maxPerChat: 1 }),
			{ name: "test", root },
			{},
			logger,
			store.transaction,
			undefined,
			undefined,
			"a",
			store.approvalBypasses,
			store.events,
		);

		await callRunner.tool({
			channel: "C1",
			actor: "U1",
			name: "lookup",
			args: { name: "web" },
			context: { agent: "a", trace: "trace-tool", thread: "thread-1", turn: "turn-1" },
			execute: async () => ({ out: "web-1" }),
		});

		assert.deepEqual((await store.events!.list({ trace: "trace-tool" })).map((row) => row.type).reverse(), [
			"tool.requested",
			"tool.started",
			"tool.completed",
		]);
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});

test("call runner emits approval timeline events", async () => {
	const root = await mkdtemp(join(tmpdir(), "heypi-approval-event-"));
	try {
		const store = sqliteStore({ path: join(root, "heypi.db") });
		await store.setup();
		const callRunner = new CallRunner(
			store.calls,
			store.approvals,
			new Queue({ maxConcurrent: 1, maxPerChat: 1 }),
			{ name: "test", root },
			{ approvers: ["U_APPROVER"] },
			logger,
			store.transaction,
			undefined,
			undefined,
			"a",
			store.approvalBypasses,
			store.events,
		);
		callRunner.register("deploy", async () => ({ out: "deployed" }));

		await callRunner.tool({
			channel: "C1",
			actor: "U1",
			name: "deploy",
			args: { env: "prod" },
			confirm: { message: "Deploy prod." },
			context: { agent: "a", trace: "trace-approval", thread: "thread-1", turn: "turn-1" },
			execute: async () => ({ out: "queued" }),
		});
		const approval = (await store.approvals.listPending({ agent: "a", limit: 1 }))[0];
		assert.ok(approval);
		await callRunner.handle({
			kind: "approve",
			channel: "C1",
			actor: "U_APPROVER",
			approvalId: approval.id,
		});

		assert.deepEqual((await store.events!.list({ trace: "trace-approval" })).map((row) => row.type).reverse(), [
			"tool.requested",
			"approval.requested",
			"approval.resolved",
			"tool.started",
			"tool.completed",
		]);
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});

test("event repo participates in store transactions", async () => {
	const root = await mkdtemp(join(tmpdir(), "heypi-event-tx-"));
	try {
		const store = sqliteStore({ path: join(root, "heypi.db") });
		await store.setup();
		await assert.rejects(
			() =>
				store.transaction!(async (tx) => {
					await tx.events!.append({ agent: "a", trace: "trace-1", type: "turn.started" });
					throw new Error("rollback");
				}),
			/rollback/,
		);
		assert.deepEqual(await store.events!.list({ trace: "trace-1" }), []);
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});
