import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { callArgs, callArgsForStorage, callContext } from "../src/core/call-reply.js";
import { CallRunner } from "../src/core/calls.js";
import { normalizeMessages } from "../src/core/messages.js";
import { commandConfirm } from "../src/core/policy.js";
import type { ToolContinuation } from "../src/core/types.js";
import { createHandler, createStatus } from "../src/io/handler.js";
import type { ReplyStream } from "../src/io/reply-stream.js";
import type { AgentReq } from "../src/runtime/agent.js";
import { applyModelPayloadConfig, streamTextDelta, toolResultParentEntryId } from "../src/runtime/pi-agent.js";
import { Queue } from "../src/runtime/queue.js";
import { sqliteStore } from "../src/store/sqlite.js";
import type { Store } from "../src/store/types.js";

async function tempDb(): Promise<{ path: string; cleanup: () => Promise<void> }> {
	const dir = await mkdtemp(join(tmpdir(), "heypi-model-"));
	return { path: join(dir, "store.db"), cleanup: () => rm(dir, { recursive: true, force: true }) };
}

function secret(value: string): string {
	return `sk-${value}`;
}

function createRestartBashHandler(store: Store, out: string) {
	return createHandler({
		agentId: "a",
		store,
		callRunner: new CallRunner(
			store.calls,
			store.approvals,
			new Queue({ maxConcurrent: 1, maxPerChat: 1 }),
			{
				name: "just-bash",
				root: ".",
				bash: async () => ({ code: 0, out, err: "", ms: 1 }),
			},
			{ approvers: ["U_ALLOWED"] },
			undefined,
			store.transaction,
			commandConfirm(),
		),
		agent: {
			ask: async () => ({ text: "ok" }),
			continue: async () => ({ text: "ok" }),
		},
	});
}

function createRestartToolHandler(store: Store, out: string) {
	const continuations: ToolContinuation[] = [];
	const runtimeScopes: Array<string | undefined> = [];
	const callRunner = new CallRunner(
		store.calls,
		store.approvals,
		new Queue({ maxConcurrent: 1, maxPerChat: 1 }),
		{ name: "tool-runtime", root: "." },
		{ approvers: ["U_ALLOWED"] },
		undefined,
		store.transaction,
	);
	const execute = async (args: Record<string, unknown>, context: { runtimeScope?: string }) => {
		runtimeScopes.push(context.runtimeScope);
		return { out: `deleted=${args.id}:${out}` };
	};
	callRunner.register("delete_ticket", execute);
	let threadId = "";
	const handler = createHandler({
		agentId: "a",
		store,
		callRunner,
		agent: {
			ask: async (req) => {
				threadId = req.threadId;
				return callRunner.tool({
					channel: req.channel,
					actor: req.actor,
					name: "delete_ticket",
					args: { id: "T1" },
					confirm: { reason: "Deletes a ticket" },
					context: {
						agent: "a",
						thread: req.threadId,
						turn: req.turnId,
						message: req.inputMessageId,
						toolCall: "tool-call-1",
						runtimeScope: req.scope?.workspace.path,
					},
					execute,
				});
			},
			continue: async (req) => {
				if (req.continuation) continuations.push(req.continuation);
				return { text: `continued ${req.continuation?.out}` };
			},
		},
	});
	return {
		handler,
		continuations,
		runtimeScopes,
		get threadId() {
			return threadId;
		},
	};
}

test("model payload config applies response verbosity", () => {
	assert.deepEqual(
		applyModelPayloadConfig(
			{ model: "gpt-5-mini", input: [], text: { format: { type: "text" } } },
			{
				provider: "openai",
				name: "gpt-5-mini",
				verbosity: "low",
			},
		),
		{ model: "gpt-5-mini", input: [], text: { format: { type: "text" }, verbosity: "low" } },
	);
});

test("approved tool continuations branch from the synthetic tool result parent", () => {
	const session = SessionManager.inMemory(".");
	const assistant = session.appendMessage({
		role: "assistant",
		content: [
			{ type: "toolCall", id: "tool-call-1", name: "first", input: {} },
			{ type: "toolCall", id: "tool-call-2", name: "second", input: {} },
		],
	} as unknown as Parameters<SessionManager["appendMessage"]>[0]);
	const firstResult = session.appendMessage({
		role: "toolResult",
		toolCallId: "tool-call-1",
		toolName: "first",
		content: [{ type: "text", text: "first result" }],
	} as Parameters<SessionManager["appendMessage"]>[0]);
	session.appendMessage({
		role: "toolResult",
		toolCallId: "tool-call-2",
		toolName: "second",
		content: [{ type: "text", text: "pending approval" }],
	} as Parameters<SessionManager["appendMessage"]>[0]);

	assert.equal(toolResultParentEntryId(session, "tool-call-1"), assistant);
	assert.equal(toolResultParentEntryId(session, "tool-call-2"), firstResult);
	session.branch(toolResultParentEntryId(session, "tool-call-2") as string);
	session.appendMessage({
		role: "toolResult",
		toolCallId: "tool-call-2",
		toolName: "second",
		content: [{ type: "text", text: "approved result" }],
	} as Parameters<SessionManager["appendMessage"]>[0]);
	const messages = session.buildSessionContext().messages;
	assert.deepEqual(
		messages.filter((message) => message.role === "toolResult").map((message) => message.toolCallId),
		["tool-call-1", "tool-call-2"],
	);
});

test("call args reserve heypi metadata without hijacking user runtimeScope args", () => {
	const stored = callArgsForStorage({ runtimeScope: "user-value" }, { runtimeScope: "channel/a/slack/T1/C1" });

	assert.deepEqual(callArgs(stored), { runtimeScope: "user-value" });
	assert.deepEqual(callContext({ threadId: null, turnId: null, messageId: null, toolCallId: null, args: stored }), {
		thread: undefined,
		turn: undefined,
		message: undefined,
		toolCall: undefined,
		runtimeScope: "channel/a/slack/T1/C1",
	});
	assert.deepEqual(
		callContext({
			threadId: null,
			turnId: null,
			messageId: null,
			toolCallId: null,
			args: JSON.stringify({ runtimeScope: "user-value" }),
		}),
		{
			thread: undefined,
			turn: undefined,
			message: undefined,
			toolCall: undefined,
			runtimeScope: undefined,
		},
	);
});

test("call args reject reserved heypi metadata and tolerate corrupt stored args", () => {
	assert.throws(() => callArgsForStorage({ __heypi: { runtimeScope: "x" } }), /reserved/);
	assert.deepEqual(callArgs("{not-json"), {});
	assert.deepEqual(
		callContext({ threadId: null, turnId: null, messageId: null, toolCallId: null, args: "{not-json" }),
		{
			thread: undefined,
			turn: undefined,
			message: undefined,
			toolCall: undefined,
			runtimeScope: undefined,
		},
	);
});

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

test("handler passes inbound attachments to agent", async () => {
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
			trace: "trace-attachments",
			provider: "test",
			eventId: "event-attachments",
			channel: "C1",
			actor: "U1",
			thread: "T1",
			text: "review",
			attachments: [{ name: "image.png", path: "/incoming/image.png", mimeType: "image/png", size: 5 }],
		});

		assert.deepEqual(request?.attachments, [
			{ name: "image.png", path: "/incoming/image.png", mimeType: "image/png", size: 5 },
		]);
	} finally {
		await db.cleanup();
	}
});

test("handler maps runtime startup events through configurable app messages", async () => {
	const db = await tempDb();
	try {
		const store = sqliteStore({ path: db.path });
		await store.setup();
		const updates: string[] = [];
		const handler = createHandler({
			agentId: "a",
			store,
			callRunner: new CallRunner(store.calls, store.approvals, new Queue({}), {
				name: "host-bash",
				root: ".",
			}),
			agent: {
				ask: async (req) => {
					await req.runtimeEvents?.({ kind: "starting", runtime: "docker" });
					return { text: "ok" };
				},
				continue: async () => ({ text: "ok" }),
			},
			messages: normalizeMessages({ runtimeStarting: "Preparing sandbox..." }),
		});

		await handler({
			trace: "trace-runtime-progress",
			provider: "test",
			eventId: "event-runtime-progress",
			channel: "C1",
			actor: "U1",
			thread: "T1",
			text: "hello",
			runtimeProgress: {
				update: async (text) => {
					updates.push(text);
				},
			},
		});

		assert.deepEqual(updates, ["Preparing sandbox..."]);
	} finally {
		await db.cleanup();
	}
});

test("handler can suppress runtime startup progress updates", async () => {
	const db = await tempDb();
	try {
		const store = sqliteStore({ path: db.path });
		await store.setup();
		const updates: string[] = [];
		const handler = createHandler({
			agentId: "a",
			store,
			callRunner: new CallRunner(store.calls, store.approvals, new Queue({}), {
				name: "host-bash",
				root: ".",
			}),
			agent: {
				ask: async (req) => {
					await req.runtimeEvents?.({ kind: "starting", runtime: "docker" });
					return { text: "ok" };
				},
				continue: async () => ({ text: "ok" }),
			},
			messages: normalizeMessages({ runtimeStarting: false }),
		});

		await handler({
			trace: "trace-runtime-progress-disabled",
			provider: "test",
			eventId: "event-runtime-progress-disabled",
			channel: "C1",
			actor: "U1",
			thread: "T1",
			text: "hello",
			runtimeProgress: {
				update: async (text) => {
					updates.push(text);
				},
			},
		});

		assert.deepEqual(updates, []);
	} finally {
		await db.cleanup();
	}
});

test("handler blocks new asks while the thread has a pending approval", async () => {
	const db = await tempDb();
	try {
		const store = sqliteStore({ path: db.path });
		await store.setup();
		const thread = await store.threads.getOrCreate({
			agent: "a",
			provider: "test",
			channel: "C1",
			actor: "U1",
			key: "T1",
		});
		const message = await store.messages.create({
			threadId: thread.id,
			provider: "test",
			role: "user",
			actor: "U1",
			text: "run command",
		});
		const turn = await store.turns.create({
			threadId: thread.id,
			inputMessageId: message.id,
			agent: "a",
			provider: "test",
			channel: "C1",
			actor: "U1",
			trace: "trace-pending",
		});
		const call = await store.calls.create({
			agent: "a",
			turnId: turn.id,
			threadId: thread.id,
			messageId: message.id,
			channel: "test::C1",
			actor: "U1",
			tool: "bash",
			command: "curl https://example.com",
			runtime: "just-bash",
			state: "pending_approval",
		});
		await store.approvals.create({
			agent: "a",
			callId: call.id,
			channel: "test::C1",
			threadId: thread.id,
			turnId: turn.id,
			requestedBy: "U1",
			command: "curl https://example.com",
			runtime: "just-bash",
			reason: "Run bash command.",
		});
		let asked = false;
		const handler = createHandler({
			agentId: "a",
			store,
			callRunner: new CallRunner(store.calls, store.approvals, new Queue({}), {
				name: "host-bash",
				root: ".",
			}),
			agent: {
				ask: async () => {
					asked = true;
					return { text: "ok" };
				},
				continue: async () => ({ text: "ok" }),
			},
		});

		const out = await handler({
			trace: "trace-new-ask",
			provider: "test",
			eventId: "event-new-ask",
			channel: "C1",
			actor: "U1",
			thread: "T1",
			text: "what now?",
		});

		assert.equal(asked, false);
		assert.equal(out?.private, undefined);
		assert.equal(out?.finalPlacement, "thread");
		assert.match(out?.text ?? "", /approval/i);
	} finally {
		await db.cleanup();
	}
});

test("handler scopes agent requests by provider team and channel", async () => {
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
			trace: "trace-scoped",
			provider: "slack",
			team: "T1",
			eventId: "event-scoped",
			channel: "C1",
			actor: "U1",
			thread: "C1:1",
			text: "hello",
		});

		assert.equal(request?.channel, "slack:T1:C1");
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
			}),
			agent: {
				ask: async () => ({ text: `token ${secret("testsecret")}` }),
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

test("handler scopes approvals by provider team and channel", async () => {
	const db = await tempDb();
	try {
		const store = sqliteStore({ path: db.path });
		await store.setup();
		const handler = createHandler({
			agentId: "a",
			store,
			callRunner: new CallRunner(
				store.calls,
				store.approvals,
				new Queue({ maxConcurrent: 1, maxPerChat: 1 }),
				{
					name: "just-bash",
					root: ".",
					bash: async () => ({ code: 0, out: "ok", err: "", ms: 1 }),
				},
				{ approvers: ["U_ALLOWED"] },
				undefined,
				store.transaction,
				commandConfirm(),
			),
			agent: {
				ask: async () => ({ text: "ok" }),
				continue: async () => ({ text: "ok" }),
			},
		});

		const requested = await handler({
			trace: "trace-approval",
			provider: "slack",
			team: "T1",
			eventId: "event-approval",
			channel: "C1",
			actor: "U_REQUESTER",
			thread: "C1:1",
			text: "/bash curl https://example.com",
		});
		const approvalId = requested?.approval?.id;
		assert.ok(approvalId);
		assert.equal((await store.approvals.get(approvalId))?.channel, "slack:T1:C1");

		const wrongTeam = await handler({
			trace: "trace-approval-wrong-team",
			provider: "slack",
			team: "T2",
			eventId: "event-approval-wrong-team",
			channel: "C1",
			actor: "U_ALLOWED",
			thread: "C1:1",
			text: `/approve ${approvalId}`,
		});
		assert.equal(wrongTeam?.private, true);
		assert.equal(wrongTeam?.replaceOriginal, true);
		assert.match(wrongTeam?.text ?? "", /unavailable/);

		const approved = await handler({
			trace: "trace-approval-right-team",
			provider: "slack",
			team: "T1",
			eventId: "event-approval-right-team",
			channel: "C1",
			actor: "U_ALLOWED",
			thread: "C1:1",
			text: `/approve ${approvalId}`,
		});
		assert.match(approved?.text ?? "", /Result: `done`/);
	} finally {
		await db.cleanup();
	}
});

test("handler approves pending bash calls after handler restart", async () => {
	const db = await tempDb();
	try {
		const store = sqliteStore({ path: db.path });
		await store.setup();
		const first = createRestartBashHandler(store, "before restart");

		const requested = await first({
			trace: "trace-restart-bash-request",
			provider: "slack",
			team: "T1",
			eventId: "event-restart-bash-request",
			channel: "C1",
			actor: "U_REQUESTER",
			thread: "C1:restart-bash",
			text: "/bash curl https://example.com",
		});
		const approvalId = requested?.approval?.id;
		assert.ok(approvalId);

		const restarted = createRestartBashHandler(store, "after restart");
		const approved = await restarted({
			trace: "trace-restart-bash-approve",
			provider: "slack",
			team: "T1",
			eventId: "event-restart-bash-approve",
			channel: "C1",
			actor: "U_ALLOWED",
			thread: "C1:restart-bash",
			text: `/approve ${approvalId}`,
		});

		assert.match(approved?.text ?? "", /Result: `done`/);
		assert.match(approved?.text ?? "", /after restart/);
		assert.equal((await store.approvals.get(approvalId))?.state, "approved");
	} finally {
		await db.cleanup();
	}
});

test("handler continues approved custom tool calls after handler restart", async () => {
	const db = await tempDb();
	try {
		const store = sqliteStore({ path: db.path });
		await store.setup();
		const first = createRestartToolHandler(store, "before restart");

		const requested = await first.handler({
			trace: "trace-restart-tool-request",
			provider: "slack",
			team: "T1",
			eventId: "event-restart-tool-request",
			channel: "C1",
			actor: "U_REQUESTER",
			thread: "C1:restart-tool",
			text: "delete ticket T1",
		});
		const approvalId = requested?.approval?.id;
		assert.ok(approvalId);

		const restarted = createRestartToolHandler(store, "after restart");
		const approved = await restarted.handler({
			trace: "trace-restart-tool-approve",
			provider: "slack",
			team: "T1",
			eventId: "event-restart-tool-approve",
			channel: "C1",
			actor: "U_ALLOWED",
			thread: "C1:restart-tool",
			text: `/approve ${approvalId}`,
		});

		assert.equal(approved?.text, "continued deleted=T1:after restart");
		assert.equal((await store.approvals.get(approvalId))?.state, "approved");
		assert.deepEqual(restarted.runtimeScopes, ["channel/a/slack/T1/C1"]);
		assert.deepEqual(restarted.continuations, [
			{
				threadId: first.threadId,
				toolCallId: "tool-call-1",
				tool: "delete_ticket",
				actor: "U_REQUESTER",
				out: "deleted=T1:after restart",
				err: "",
				isError: false,
			},
		]);
	} finally {
		await db.cleanup();
	}
});

test("handler lets expired denials replace the original approval surface", async () => {
	const db = await tempDb();
	try {
		const store = sqliteStore({ path: db.path });
		await store.setup();
		const handler = createHandler({
			agentId: "a",
			store,
			callRunner: new CallRunner(
				store.calls,
				store.approvals,
				new Queue({ maxConcurrent: 1, maxPerChat: 1 }),
				{
					name: "just-bash",
					root: ".",
					bash: async () => ({ code: 0, out: "ok", err: "", ms: 1 }),
				},
				{ approvers: ["U_ALLOWED"], expiresInMs: -1 },
				undefined,
				store.transaction,
				commandConfirm(),
			),
			agent: {
				ask: async () => ({ text: "ok" }),
				continue: async () => ({ text: "ok" }),
			},
		});

		const requested = await handler({
			trace: "trace-expired-deny-request",
			provider: "slack",
			team: "T1",
			eventId: "event-expired-deny-request",
			channel: "C1",
			actor: "U_REQUESTER",
			thread: "C1:1",
			text: "/bash curl https://example.com",
		});
		const approvalId = requested?.approval?.id;
		assert.ok(approvalId);

		let replacement = "";
		let resolution: string | undefined;
		const denied = await handler({
			trace: "trace-expired-deny",
			provider: "slack",
			team: "T1",
			eventId: "event-expired-deny",
			channel: "C1",
			actor: "U_ALLOWED",
			thread: "C1:1",
			text: `/deny ${approvalId}`,
			replace: async (out) => {
				replacement = out.text;
				resolution = out.approvalResolution;
			},
		});

		assert.equal(denied, undefined);
		assert.equal(resolution, "expired");
		assert.match(replacement, /Approval expired/);
		assert.match(replacement, /curl https:\/\/example.com/);
	} finally {
		await db.cleanup();
	}
});

test("approvals command lists pending approvals for approvers only", async () => {
	const db = await tempDb();
	try {
		const store = sqliteStore({ path: db.path });
		await store.setup();
		const approval = { approvers: ["U_ALLOWED"] };
		const handler = createHandler({
			agentId: "a",
			store,
			approval,
			callRunner: new CallRunner(
				store.calls,
				store.approvals,
				new Queue({ maxConcurrent: 1, maxPerChat: 1 }),
				{
					name: "just-bash",
					root: ".",
					bash: async () => ({ code: 0, out: "ok", err: "", ms: 1 }),
				},
				approval,
				undefined,
				store.transaction,
				commandConfirm(),
			),
			agent: {
				ask: async () => ({ text: "ok" }),
				continue: async () => ({ text: "ok" }),
			},
		});

		const requested = await handler({
			trace: "trace-approval",
			provider: "slack",
			team: "T1",
			eventId: "event-approval",
			channel: "C1",
			actor: "U_REQUESTER",
			thread: "C1:1",
			text: "/bash curl https://example.com",
		});
		const approvalId = requested?.approval?.id;
		assert.ok(approvalId);

		const denied = await handler({
			trace: "trace-approvals-denied",
			provider: "slack",
			team: "T1",
			eventId: "event-approvals-denied",
			channel: "C1",
			actor: "U_OTHER",
			thread: "D1:D1",
			text: "/approvals",
		});
		assert.equal(denied?.private, true);
		assert.match(denied?.text ?? "", /not allowed/);

		const listed = await handler({
			trace: "trace-approvals",
			provider: "slack",
			team: "T1",
			eventId: "event-approvals",
			channel: "D1",
			actor: "U_ALLOWED",
			thread: "D1:D1",
			text: "/approvals",
		});
		assert.equal(listed?.private, true);
		assert.match(listed?.text ?? "", new RegExp(approvalId));
		assert.match(listed?.text ?? "", /Run bash command/);
	} finally {
		await db.cleanup();
	}
});

test("bypasses command lists active approval bypasses for approvers only", async () => {
	const db = await tempDb();
	try {
		const store = sqliteStore({ path: db.path });
		await store.setup();
		const approval = {
			approvers: ["U_ALLOWED"],
			bypass: { durationMs: 60_000, scope: "thread" as const },
		};
		const handler = createHandler({
			agentId: "a",
			store,
			approval,
			callRunner: new CallRunner(
				store.calls,
				store.approvals,
				new Queue({ maxConcurrent: 1, maxPerChat: 1 }),
				{
					name: "just-bash",
					root: ".",
					bash: async () => ({ code: 0, out: "ok", err: "", ms: 1 }),
				},
				approval,
				undefined,
				store.transaction,
				commandConfirm(),
				undefined,
				"a",
				store.approvalBypasses,
			),
			agent: {
				ask: async () => ({ text: "ok" }),
				continue: async () => ({ text: "ok" }),
			},
		});

		const requested = await handler({
			trace: "trace-bypass-request",
			provider: "slack",
			team: "T1",
			eventId: "event-bypass-request",
			channel: "C1",
			actor: "U_REQUESTER",
			thread: "C1:1",
			text: "/bash curl https://example.com",
		});
		const approvalId = requested?.approval?.id;
		assert.ok(approvalId);

		await handler({
			trace: "trace-bypass-approve",
			provider: "slack",
			team: "T1",
			eventId: "event-bypass-approve",
			channel: "C1",
			actor: "U_ALLOWED",
			thread: "C1:1",
			text: `/approve ${approvalId} bypass`,
		});

		const denied = await handler({
			trace: "trace-bypasses-denied",
			provider: "slack",
			team: "T1",
			eventId: "event-bypasses-denied",
			channel: "C1",
			actor: "U_OTHER",
			thread: "C1:1",
			text: "/bypasses",
		});
		assert.equal(denied?.private, true);
		assert.match(denied?.text ?? "", /not allowed/);

		const listed = await handler({
			trace: "trace-bypasses",
			provider: "slack",
			team: "T1",
			eventId: "event-bypasses",
			channel: "D1",
			actor: "U_ALLOWED",
			thread: "D1:D1",
			text: "/bypasses",
		});
		assert.equal(listed?.private, true);
		assert.match(listed?.text ?? "", /Active approval bypasses/);
		assert.match(listed?.text ?? "", /scope thread/);
		assert.match(listed?.text ?? "", /created by U_ALLOWED/);
		assert.match(listed?.text ?? "", /\/revoke <bypass-id>/);
	} finally {
		await db.cleanup();
	}
});

test("bot actors cannot list approvals through zero-config fallback", async () => {
	const db = await tempDb();
	try {
		const store = sqliteStore({ path: db.path });
		await store.setup();
		const handler = createHandler({
			agentId: "a",
			store,
			callRunner: new CallRunner(
				store.calls,
				store.approvals,
				new Queue({ maxConcurrent: 1, maxPerChat: 1 }),
				{
					name: "just-bash",
					root: ".",
					bash: async () => ({ code: 0, out: "ok", err: "", ms: 1 }),
				},
				{},
				undefined,
				store.transaction,
				commandConfirm(),
			),
			agent: {
				ask: async () => ({ text: "ok" }),
				continue: async () => ({ text: "ok" }),
			},
		});

		await handler({
			trace: "trace-bot-approval-request",
			provider: "slack",
			team: "T1",
			eventId: "event-bot-approval-request",
			channel: "C1",
			actor: "U_REQUESTER",
			thread: "C1:1",
			text: "/bash curl https://example.com",
		});

		const listed = await handler({
			trace: "trace-bot-approvals",
			provider: "slack",
			team: "T1",
			eventId: "event-bot-approvals",
			channel: "C1",
			actor: "B_DEPLOY",
			actorBot: true,
			thread: "C1:1",
			text: "/approvals",
		});

		assert.equal(listed?.private, true);
		assert.match(listed?.text ?? "", /not allowed/);

		const bypasses = await handler({
			trace: "trace-bot-bypasses",
			provider: "slack",
			team: "T1",
			eventId: "event-bot-bypasses",
			channel: "C1",
			actor: "B_DEPLOY",
			actorBot: true,
			thread: "C1:1",
			text: "/bypasses",
		});

		assert.equal(bypasses?.private, true);
		assert.match(bypasses?.text ?? "", /not allowed/);
	} finally {
		await db.cleanup();
	}
});

test("status only reports pending approvals for the requested run", async () => {
	const db = await tempDb();
	try {
		const store = sqliteStore({ path: db.path });
		await store.setup();
		const thread = await store.threads.getOrCreate({
			agent: "a",
			provider: "webhook",
			channel: "whch_test",
			actor: "user",
			key: "whth_test",
		});
		const firstMessage = await store.messages.create({
			threadId: thread.id,
			provider: "webhook",
			role: "user",
			actor: "user",
			text: "needs approval",
		});
		const firstTurn = await store.turns.create({
			threadId: thread.id,
			inputMessageId: firstMessage.id,
			agent: "a",
			provider: "webhook",
			channel: "whch_test",
			actor: "user",
			trace: "run-with-approval",
		});
		const command = `curl -H 'Authorization: Bearer ${secret("secret")}' https://example.com`;
		const call = await store.calls.create({
			agent: "a",
			turnId: firstTurn.id,
			threadId: thread.id,
			messageId: firstMessage.id,
			channel: "webhook::whch_test",
			actor: "user",
			tool: "bash",
			command,
			runtime: "just-bash",
			state: "pending_approval",
		});
		const approval = await store.approvals.create({
			agent: "a",
			callId: call.id,
			channel: "webhook::whch_test",
			threadId: thread.id,
			turnId: firstTurn.id,
			requestedBy: "user",
			command,
			runtime: "just-bash",
			reason: "test",
		});

		const secondMessage = await store.messages.create({
			threadId: thread.id,
			provider: "webhook",
			role: "user",
			actor: "user",
			text: "normal run",
		});
		const secondTurn = await store.turns.create({
			threadId: thread.id,
			inputMessageId: secondMessage.id,
			agent: "a",
			provider: "webhook",
			channel: "whch_test",
			actor: "user",
			trace: "run-done",
		});
		const result = await store.messages.create({
			threadId: thread.id,
			provider: "webhook",
			role: "assistant",
			actor: "heypi",
			text: `done ${secret("secret")}`,
		});
		await store.turns.finish(secondTurn.id, { state: "done", resultMessageId: result.id });

		const status = createStatus({ agentId: "a", store });
		const done = await status({ provider: "webhook", threadId: "whth_test", runId: "run-done" });
		const pending = await status({ provider: "webhook", threadId: "whth_test", runId: "run-with-approval" });

		assert.equal(done?.status, "done");
		assert.equal(done?.approval, undefined);
		assert.equal(done?.text, "done sk-<redacted>");
		assert.equal(pending?.status, "pending_approval");
		assert.equal(pending?.approval?.id, approval.id);
		assert.equal(pending?.approval?.command, "curl -H 'Authorization: Bearer sk-<redacted>' https://example.com");
	} finally {
		await db.cleanup();
	}
});

test("status resolves team-scoped threads with the same key", async () => {
	const db = await tempDb();
	try {
		const store = sqliteStore({ path: db.path });
		await store.setup();
		const first = await store.threads.getOrCreate({
			agent: "a",
			provider: "slack",
			team: "T1",
			channel: "C1",
			actor: "U1",
			key: "C1:1",
		});
		const second = await store.threads.getOrCreate({
			agent: "a",
			provider: "slack",
			team: "T2",
			channel: "C1",
			actor: "U1",
			key: "C1:1",
		});
		const firstMessage = await store.messages.create({
			threadId: first.id,
			provider: "slack",
			role: "user",
			actor: "U1",
			text: "first",
		});
		const secondMessage = await store.messages.create({
			threadId: second.id,
			provider: "slack",
			role: "user",
			actor: "U1",
			text: "second",
		});
		const firstTurn = await store.turns.create({
			threadId: first.id,
			inputMessageId: firstMessage.id,
			agent: "a",
			provider: "slack",
			channel: "C1",
			actor: "U1",
			trace: "run",
		});
		const secondTurn = await store.turns.create({
			threadId: second.id,
			inputMessageId: secondMessage.id,
			agent: "a",
			provider: "slack",
			channel: "C1",
			actor: "U1",
			trace: "run",
		});
		const firstResult = await store.messages.create({
			threadId: first.id,
			provider: "slack",
			role: "assistant",
			actor: "heypi",
			text: "team one",
		});
		const secondResult = await store.messages.create({
			threadId: second.id,
			provider: "slack",
			role: "assistant",
			actor: "heypi",
			text: "team two",
		});
		await store.turns.finish(firstTurn.id, { state: "done", resultMessageId: firstResult.id });
		await store.turns.finish(secondTurn.id, { state: "done", resultMessageId: secondResult.id });

		const status = createStatus({ agentId: "a", store });

		assert.equal((await status({ provider: "slack", team: "T1", threadId: "C1:1", runId: "run" }))?.text, "team one");
		assert.equal((await status({ provider: "slack", team: "T2", threadId: "C1:1", runId: "run" }))?.text, "team two");
		assert.equal(await status({ provider: "slack", threadId: "C1:1", runId: "run" }), undefined);
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
			}),
			agent: {
				ask: async (req) => {
					await req.stream?.update("token sk-<redacted>");
					return { text: `token ${secret("testsecret")}` };
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
		delta: secret("secret"),
		stream,
		logger: { warn() {} },
		context: {},
	});

	await updated;
	assert.equal(out, `token ${secret("secret")}`);
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
