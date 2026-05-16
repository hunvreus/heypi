import assert from "node:assert/strict";
import { test } from "node:test";
import { CallRunner } from "../src/core/calls.js";
import type { Logger } from "../src/core/log.js";
import type { CallState } from "../src/core/types.js";
import { Queue } from "../src/runtime/queue.js";
import type { Runtime } from "../src/runtime/types.js";
import type { Approval, Approvals, Call, Calls } from "../src/store/types.js";

function runtime(): Runtime {
	return {
		name: "just-bash",
		root: "/tmp/unused",
		capabilities: { bash: true },
		bash: async () => ({ code: 0, out: "ok", err: "", ms: 1 }),
	};
}

test("approval approvers reject unauthorized actors and keep approval pending", async () => {
	const calls = new FakeCalls();
	const approvals = new FakeApprovals();
	const events: LogEvent[] = [];
	const callRunner = new CallRunner(
		calls,
		approvals,
		new Queue({ maxConcurrent: 1, maxPerChat: 1 }),
		runtime(),
		{
			approvers: ["U_ALLOWED"],
		},
		captureLogger(events),
	);

	const requested = await callRunner.bash("C1", "U_REQUESTER", "curl https://example.com");
	assert.equal(requested.approval?.id, approvals.rows[0]?.id);

	const denied = await callRunner.handle({
		kind: "approve",
		approvalId: approvals.rows[0].id,
		channel: "C1",
		actor: "U_OTHER",
	});
	assert.equal(denied.private, true);
	assert.match(denied.text, /not allowed/i);
	assert.equal(approvals.rows[0].state, "pending");
	assert.equal(calls.rows[0].state, "pending_approval");
	assert.equal(
		events.some((event) => event.event === "approval.unauthorized"),
		true,
	);
});

test("authorized approval executes the pending command", async () => {
	const calls = new FakeCalls();
	const approvals = new FakeApprovals();
	const events: LogEvent[] = [];
	const callRunner = new CallRunner(
		calls,
		approvals,
		new Queue({ maxConcurrent: 1, maxPerChat: 1 }),
		runtime(),
		{
			approvers: ["U_ALLOWED"],
		},
		captureLogger(events),
	);

	await callRunner.bash("C1", "U_REQUESTER", "curl https://example.com");
	const approved = await callRunner.handle({
		kind: "approve",
		approvalId: approvals.rows[0].id,
		channel: "C1",
		actor: "U_ALLOWED",
	});

	assert.equal(approved.text.includes("state=done"), true);
	assert.equal(approvals.rows[0].state, "approved");
	assert.equal(approvals.rows[0].resolvedBy, "U_ALLOWED");
	assert.equal(calls.rows[0].state, "done");
	assert.equal(
		events.some((event) => event.event === "approval.approved"),
		true,
	);
});

test("command policy allow pattern bypasses default approval pattern", async () => {
	const calls = new FakeCalls();
	const approvals = new FakeApprovals();
	const callRunner = new CallRunner(
		calls,
		approvals,
		new Queue({ maxConcurrent: 1, maxPerChat: 1 }),
		runtime(),
		{},
		noLogger(),
		undefined,
		{ allow: [/^curl -I /] },
	);

	const reply = await callRunner.bash("C1", "U_REQUESTER", "curl -I https://example.com");

	assert.match(reply.text, /state=done/);
	assert.equal(approvals.rows.length, 0);
	assert.equal(calls.rows[0].policyReason, "allowed by /^curl -I /");
});

test("authorized approval executes a confirmed custom tool", async () => {
	const calls = new FakeCalls();
	const approvals = new FakeApprovals();
	const callRunner = new CallRunner(
		calls,
		approvals,
		new Queue({ maxConcurrent: 1, maxPerChat: 1 }),
		runtime(),
		{
			approvers: ["U_ALLOWED"],
		},
		noLogger(),
	);

	const execute = async (args: Record<string, unknown>) => ({ out: `deleted=${args.id}` });
	callRunner.register("delete_ticket", execute);
	const requested = await callRunner.tool({
		channel: "C1",
		actor: "U_REQUESTER",
		name: "delete_ticket",
		args: { id: "T1" },
		confirm: { reason: "Deletes a ticket" },
		execute,
	});
	assert.equal(requested.approval?.id, approvals.rows[0]?.id);

	const approved = await callRunner.handle({
		kind: "approve",
		approvalId: approvals.rows[0].id,
		channel: "C1",
		actor: "U_ALLOWED",
	});

	assert.match(approved.text, /deleted=T1/);
	assert.equal(calls.rows[0].tool, "delete_ticket");
	assert.equal(calls.rows[0].state, "done");
	assert.equal(approvals.rows[0].state, "approved");
});

test("authorized denial logs approval.denied", async () => {
	const calls = new FakeCalls();
	const approvals = new FakeApprovals();
	const events: LogEvent[] = [];
	const callRunner = new CallRunner(
		calls,
		approvals,
		new Queue({ maxConcurrent: 1, maxPerChat: 1 }),
		runtime(),
		{ approvers: ["U_ALLOWED"] },
		captureLogger(events),
	);

	await callRunner.bash("C1", "U_REQUESTER", "curl https://example.com");
	const denied = await callRunner.handle({
		kind: "deny",
		approvalId: approvals.rows[0].id,
		channel: "C1",
		actor: "U_ALLOWED",
	});

	assert.match(denied.text, /state=blocked/);
	assert.equal(approvals.rows[0].state, "denied");
	assert.equal(
		events.some((event) => event.event === "approval.denied"),
		true,
	);
});

test("expired approval logs approval.expired", async () => {
	const calls = new FakeCalls();
	const approvals = new FakeApprovals();
	const events: LogEvent[] = [];
	const callRunner = new CallRunner(
		calls,
		approvals,
		new Queue({ maxConcurrent: 1, maxPerChat: 1 }),
		runtime(),
		{ approvers: ["U_ALLOWED"], expiresInMs: -1 },
		captureLogger(events),
	);

	await callRunner.bash("C1", "U_REQUESTER", "curl https://example.com");
	const expired = await callRunner.handle({
		kind: "approve",
		approvalId: approvals.rows[0].id,
		channel: "C1",
		actor: "U_ALLOWED",
	});

	assert.equal(expired.private, true);
	assert.match(expired.text, /expired/);
	assert.equal(approvals.rows[0].state, "denied");
	assert.equal(
		events.some((event) => event.event === "approval.expired"),
		true,
	);
});

test("resolved approval logs approval.already_resolved", async () => {
	const calls = new FakeCalls();
	const approvals = new FakeApprovals();
	const events: LogEvent[] = [];
	const callRunner = new CallRunner(
		calls,
		approvals,
		new Queue({ maxConcurrent: 1, maxPerChat: 1 }),
		runtime(),
		{ approvers: ["U_ALLOWED"] },
		captureLogger(events),
	);

	await callRunner.bash("C1", "U_REQUESTER", "curl https://example.com");
	await callRunner.handle({
		kind: "deny",
		approvalId: approvals.rows[0].id,
		channel: "C1",
		actor: "U_ALLOWED",
	});
	const resolved = await callRunner.handle({
		kind: "approve",
		approvalId: approvals.rows[0].id,
		channel: "C1",
		actor: "U_ALLOWED",
	});

	assert.equal(resolved.private, true);
	assert.match(resolved.text, /already denied/);
	assert.equal(
		events.some((event) => event.event === "approval.already_resolved"),
		true,
	);
});

test("approved tool call returns continuation metadata when it came from Pi", async () => {
	const calls = new FakeCalls();
	const approvals = new FakeApprovals();
	const callRunner = new CallRunner(
		calls,
		approvals,
		new Queue({ maxConcurrent: 1, maxPerChat: 1 }),
		runtime(),
		{ approvers: ["U_ALLOWED"] },
		noLogger(),
	);

	const execute = async (args: Record<string, unknown>) => ({ out: `deleted=${args.id}` });
	callRunner.register("delete_ticket", execute);
	await callRunner.tool({
		channel: "C1",
		actor: "U_REQUESTER",
		name: "delete_ticket",
		args: { id: "T1" },
		confirm: { reason: "Deletes a ticket" },
		context: { thread: "thread-1", toolCall: "tool-call-1" },
		execute,
	});
	const approved = await callRunner.handle({
		kind: "approve",
		approvalId: approvals.rows[0].id,
		channel: "C1",
		actor: "U_ALLOWED",
	});

	assert.deepEqual(approved.continuation, {
		threadId: "thread-1",
		toolCallId: "tool-call-1",
		tool: "delete_ticket",
		out: "deleted=T1",
		err: "",
		isError: false,
	});
});

class FakeCalls implements Calls {
	readonly rows: Call[] = [];

	async create(input: {
		turnId?: string;
		threadId?: string;
		messageId?: string;
		channel: string;
		actor?: string;
		tool: string;
		toolCallId?: string;
		command?: string;
		args?: string;
		runtime?: string;
		state: CallState;
		policyReason?: string;
	}): Promise<Call> {
		const now = Date.now();
		const row: Call = {
			id: `call-${this.rows.length + 1}`,
			turnId: input.turnId ?? null,
			threadId: input.threadId ?? null,
			messageId: input.messageId ?? null,
			channel: input.channel,
			actor: input.actor ?? null,
			tool: input.tool,
			toolCallId: input.toolCallId ?? null,
			command: input.command ?? null,
			args: input.args ?? null,
			runtime: input.runtime ?? null,
			policyReason: input.policyReason ?? null,
			state: input.state,
			code: null,
			out: null,
			err: null,
			ms: null,
			queueWaitMs: null,
			createdAt: now,
			updatedAt: now,
		};
		this.rows.push(row);
		return row;
	}

	async get(id: string): Promise<Call | undefined> {
		return this.rows.find((row) => row.id === id);
	}

	async getByChannel(channel: string, id: string): Promise<Call | undefined> {
		return this.rows.find((row) => row.channel === channel && row.id === id);
	}

	async listForThread(threadId: string): Promise<Call[]> {
		return this.rows.filter((row) => row.threadId === threadId);
	}

	async setState(id: string, state: CallState): Promise<void> {
		const row = await this.get(id);
		if (row) row.state = state;
	}

	async finish(
		id: string,
		input: { state: CallState; code: number; out: string; err: string; ms: number; queueWaitMs: number },
	): Promise<void> {
		const row = await this.get(id);
		if (!row) return;
		row.state = input.state;
		row.code = input.code;
		row.out = input.out;
		row.err = input.err;
		row.ms = input.ms;
		row.queueWaitMs = input.queueWaitMs;
	}
}

function noLogger(): Logger {
	return {
		debug: () => undefined,
		info: () => undefined,
		warn: () => undefined,
		error: () => undefined,
	};
}

type LogEvent = { level: keyof Logger; event: string; input?: Record<string, unknown> };

function captureLogger(events: LogEvent[]): Logger {
	return {
		debug: (event, input) => events.push({ level: "debug", event, input }),
		info: (event, input) => events.push({ level: "info", event, input }),
		warn: (event, input) => events.push({ level: "warn", event, input }),
		error: (event, input) => events.push({ level: "error", event, input }),
	};
}

class FakeApprovals implements Approvals {
	readonly rows: Approval[] = [];

	async create(input: {
		callId: string;
		channel: string;
		threadId?: string;
		turnId?: string;
		requestMessageId?: string;
		requestedBy?: string;
		expiresAt?: number;
		command: string;
		runtime: string;
		reason: string;
	}): Promise<Approval> {
		const row: Approval = {
			id: `approval-${this.rows.length + 1}`,
			callId: input.callId,
			channel: input.channel,
			threadId: input.threadId ?? null,
			turnId: input.turnId ?? null,
			requestMessageId: input.requestMessageId ?? null,
			command: input.command,
			runtime: input.runtime,
			reason: input.reason,
			state: "pending",
			requestedBy: input.requestedBy ?? null,
			requestedAt: Date.now(),
			expiresAt: input.expiresAt ?? null,
			resolvedAt: null,
			resolvedBy: null,
		};
		this.rows.push(row);
		return row;
	}

	async get(id: string): Promise<Approval | undefined> {
		return this.rows.find((row) => row.id === id);
	}

	async getByChannel(channel: string, id: string): Promise<Approval | undefined> {
		return this.rows.find((row) => row.channel === channel && row.id === id);
	}

	async getPending(channel: string, id: string): Promise<Approval | undefined> {
		return this.rows.find((row) => row.channel === channel && row.id === id && row.state === "pending");
	}

	async listPending(input: { threadId?: string } = {}): Promise<Approval[]> {
		return this.rows.filter((row) => row.state === "pending" && (!input.threadId || row.threadId === input.threadId));
	}

	async resolve(id: string, state: "approved" | "denied", actor: string): Promise<boolean> {
		const row = await this.get(id);
		if (!row || row.state !== "pending") return false;
		row.state = state;
		row.resolvedBy = actor;
		row.resolvedAt = Date.now();
		return true;
	}
}
