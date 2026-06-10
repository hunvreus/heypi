import assert from "node:assert/strict";
import { test } from "node:test";
import { CallRunner } from "../src/core/calls.js";
import type { Logger } from "../src/core/log.js";
import { normalizeMessages } from "../src/core/messages.js";
import { commandConfirm } from "../src/core/policy.js";
import type { CallErrorKind, CallState } from "../src/core/types.js";
import { RUNTIME_STARTUP_ERROR_KIND, RuntimeStartupError } from "../src/runtime/errors.js";
import { Queue } from "../src/runtime/queue.js";
import type { Runtime } from "../src/runtime/types.js";
import type { Approval, ApprovalBypass, ApprovalBypasses, Approvals, Call, Calls } from "../src/store/types.js";

function runtime(): Runtime {
	return {
		name: "just-bash",
		root: "/tmp/unused",
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
		undefined,
		commandConfirm(),
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
		undefined,
		commandConfirm(),
	);

	await callRunner.bash("C1", "U_REQUESTER", "curl https://example.com");
	const approved = await callRunner.handle({
		kind: "approve",
		approvalId: approvals.rows[0].id,
		channel: "C1",
		actor: "U_ALLOWED",
	});

	assert.match(approved.text, /Result: `done`/);
	assert.equal(approvals.rows[0].state, "approved");
	assert.equal(approvals.rows[0].resolvedBy, "U_ALLOWED");
	assert.equal(calls.rows[0].state, "done");
	assert.equal(
		events.some((event) => event.event === "approval.approved"),
		true,
	);
});

test("bot actors cannot approve through zero-config fallback", async () => {
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
		commandConfirm(),
	);

	await callRunner.bash("C1", "U_REQUESTER", "curl https://example.com");
	const denied = await callRunner.handle(
		{
			kind: "approve",
			approvalId: approvals.rows[0].id,
			channel: "C1",
			actor: "B_DEPLOY",
		},
		{ actorBot: true },
	);

	assert.equal(denied.private, true);
	assert.match(denied.text, /not allowed/i);
	assert.equal(approvals.rows[0].state, "pending");
	assert.equal(calls.rows[0].state, "pending_approval");
});

test("explicit bot approvers can approve", async () => {
	const calls = new FakeCalls();
	const approvals = new FakeApprovals();
	const callRunner = new CallRunner(
		calls,
		approvals,
		new Queue({ maxConcurrent: 1, maxPerChat: 1 }),
		runtime(),
		{ approvers: ["B_DEPLOY"] },
		noLogger(),
		undefined,
		commandConfirm(),
	);

	await callRunner.bash("C1", "U_REQUESTER", "curl https://example.com");
	const approved = await callRunner.handle(
		{
			kind: "approve",
			approvalId: approvals.rows[0].id,
			channel: "C1",
			actor: "B_DEPLOY",
		},
		{ actorBot: true },
	);

	assert.match(approved.text, /Result: `done`/);
	assert.equal(approvals.rows[0].state, "approved");
	assert.equal(approvals.rows[0].resolvedBy, "B_DEPLOY");
});

test("approval bypass skips confirmation in matching thread until revoked", async () => {
	const calls = new FakeCalls();
	const approvals = new FakeApprovals();
	const bypasses = new FakeBypasses();
	const callRunner = new CallRunner(
		calls,
		approvals,
		new Queue({ maxConcurrent: 1, maxPerChat: 1 }),
		runtime(),
		{
			approvers: ["U_ALLOWED"],
			bypass: { durationMs: 60_000, maxDurationMs: 60_000, scope: "thread" },
		},
		noLogger(),
		undefined,
		commandConfirm(),
		normalizeMessages(),
		"default",
		bypasses,
	);

	await callRunner.bash("slack:T1:C1", "U_REQUESTER", "curl https://example.com", { thread: "thread-1" });
	const approved = await callRunner.handle(
		{
			kind: "approve",
			approvalId: approvals.rows[0].id,
			channel: "slack:T1:C1",
			actor: "U_ALLOWED",
			bypass: true,
		},
		{ thread: "thread-1" },
	);
	assert.match(approved.text, /Result: `done`/);
	assert.equal(bypasses.rows.length, 1);

	const bypassed = await callRunner.bash("slack:T1:C1", "U_REQUESTER", "curl https://example.com", {
		thread: "thread-1",
	});
	assert.match(bypassed.text, /Result: `done`/);
	assert.equal(approvals.rows.length, 1);

	const revoked = await callRunner.handle(
		{ kind: "revoke", bypassId: bypasses.rows[0].id, channel: "slack:T1:C1", actor: "U_ALLOWED" },
		{ thread: "thread-1" },
	);
	assert.match(revoked.text, /revoked/i);

	const requestedAgain = await callRunner.bash("slack:T1:C1", "U_REQUESTER", "curl https://example.com", {
		thread: "thread-1",
	});
	assert.equal(requestedAgain.approval?.id, approvals.rows[1]?.id);
});

test("approval admins inherit approver permissions", async () => {
	const calls = new FakeCalls();
	const approvals = new FakeApprovals();
	const callRunner = new CallRunner(
		calls,
		approvals,
		new Queue({ maxConcurrent: 1, maxPerChat: 1 }),
		runtime(),
		{
			admins: ["U_ADMIN"],
			approvers: ["U_APPROVER"],
		},
		noLogger(),
		undefined,
		commandConfirm(),
	);

	await callRunner.bash("C1", "U_REQUESTER", "curl https://example.com");
	const approved = await callRunner.handle({
		kind: "approve",
		approvalId: approvals.rows[0].id,
		channel: "C1",
		actor: "U_ADMIN",
	});

	assert.match(approved.text, /Result: `done`/);
	assert.equal(approvals.rows[0].state, "approved");
	assert.equal(approvals.rows[0].resolvedBy, "U_ADMIN");
	assert.equal(calls.rows[0].state, "done");
});

test("approval requester can approve when self approval is enabled by default", async () => {
	const calls = new FakeCalls();
	const approvals = new FakeApprovals();
	const callRunner = new CallRunner(
		calls,
		approvals,
		new Queue({ maxConcurrent: 1, maxPerChat: 1 }),
		runtime(),
		{
			approvers: ["U_REQUESTER"],
		},
		noLogger(),
		undefined,
		commandConfirm(),
	);

	await callRunner.bash("C1", "U_REQUESTER", "curl https://example.com");
	const approved = await callRunner.handle({
		kind: "approve",
		approvalId: approvals.rows[0].id,
		channel: "C1",
		actor: "U_REQUESTER",
	});

	assert.match(approved.text, /Result: `done`/);
	assert.equal(approvals.rows[0].state, "approved");
	assert.equal(approvals.rows[0].resolvedBy, "U_REQUESTER");
});

test("approval requester cannot approve when self approval is disabled", async () => {
	const calls = new FakeCalls();
	const approvals = new FakeApprovals();
	const callRunner = new CallRunner(
		calls,
		approvals,
		new Queue({ maxConcurrent: 1, maxPerChat: 1 }),
		runtime(),
		{
			approvers: ["U_REQUESTER"],
			allowSelfApproval: false,
		},
		noLogger(),
		undefined,
		commandConfirm(),
	);

	await callRunner.bash("C1", "U_REQUESTER", "curl https://example.com");
	const denied = await callRunner.handle({
		kind: "approve",
		approvalId: approvals.rows[0].id,
		channel: "C1",
		actor: "U_REQUESTER",
	});

	assert.equal(denied.private, true);
	assert.match(denied.text, /not allowed/i);
	assert.equal(approvals.rows[0].state, "pending");
	assert.equal(calls.rows[0].state, "pending_approval");
});

test("group approver executes the pending command", async () => {
	const calls = new FakeCalls();
	const approvals = new FakeApprovals();
	const callRunner = new CallRunner(
		calls,
		approvals,
		new Queue({ maxConcurrent: 1, maxPerChat: 1 }),
		runtime(),
		{
			approvers: { groups: ["S_ALLOWED"] },
		},
		undefined,
		undefined,
		commandConfirm(),
	);

	await callRunner.bash("C1", "U_REQUESTER", "curl https://example.com");
	const approved = await callRunner.handle(
		{
			kind: "approve",
			approvalId: approvals.rows[0].id,
			channel: "C1",
			actor: "U_ALLOWED",
		},
		{ actorGroups: ["S_ALLOWED"] },
	);

	assert.match(approved.text, /Result: `done`/);
	assert.equal(approvals.rows[0].state, "approved");
	assert.equal(approvals.rows[0].resolvedBy, "U_ALLOWED");
	assert.equal(calls.rows[0].state, "done");
});

test("bash runtime startup failures are failed calls", async () => {
	const calls = new FakeCalls();
	const callRunner = new CallRunner(
		calls,
		new FakeApprovals(),
		new Queue({ maxConcurrent: 1, maxPerChat: 1 }),
		{
			name: "docker",
			root: "/tmp/unused",
			bash: async () => {
				throw new RuntimeStartupError("Docker runtime failed to start container heypi-test: daemon unavailable");
			},
		},
		{},
		noLogger(),
	);

	const failed = await callRunner.bash("C1", "U1", "echo ok");

	assert.match(failed.text, /Result: `failed` exit=1/);
	assert.match(failed.text, /Runtime failed\. Ask an admin to check the server logs\./);
	assert.doesNotMatch(failed.text, /Docker|daemon unavailable/);
	assert.equal(calls.rows[0].state, "failed");
	assert.equal(calls.rows[0].code, 1);
	assert.equal(calls.rows[0].err, "Docker runtime failed to start container heypi-test: daemon unavailable");
	assert.equal(calls.rows[0].errKind, RUNTIME_STARTUP_ERROR_KIND);
});

test("approval resolution is scoped by agent", async () => {
	const calls = new FakeCalls();
	const approvals = new FakeApprovals();
	const callRunner = new CallRunner(
		calls,
		approvals,
		new Queue({ maxConcurrent: 1, maxPerChat: 1 }),
		runtime(),
		{ approvers: ["U_ALLOWED"] },
		noLogger(),
		undefined,
		commandConfirm(),
	);

	await callRunner.bash("C1", "U_REQUESTER", "curl https://example.com", { agent: "agent-b" });
	const wrongAgent = await callRunner.handle(
		{
			kind: "approve",
			approvalId: approvals.rows[0].id,
			channel: "C1",
			actor: "U_ALLOWED",
		},
		{ agent: "agent-a" },
	);

	assert.equal(wrongAgent.private, true);
	assert.match(wrongAgent.text, /Approval unavailable/);
	assert.equal(approvals.rows[0].state, "pending");
	assert.equal(calls.rows[0].state, "pending_approval");

	const approved = await callRunner.handle(
		{
			kind: "approve",
			approvalId: approvals.rows[0].id,
			channel: "C1",
			actor: "U_ALLOWED",
		},
		{ agent: "agent-b" },
	);
	assert.match(approved.text, /Result: `done`/);
	assert.equal(approvals.rows[0].state, "approved");
	assert.equal(calls.rows[0].state, "done");
});

test("command confirmation allow pattern bypasses default approval pattern", async () => {
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
		commandConfirm({ allow: [/^curl -I /] }),
	);

	const reply = await callRunner.bash("C1", "U_REQUESTER", "curl -I https://example.com");

	assert.match(reply.text, /Result: `done`/);
	assert.equal(approvals.rows.length, 0);
	assert.equal(calls.rows[0].policyReason, "tool default");
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

test("approval details persist, normalize, and roundtrip through approval summaries", async () => {
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

	const execute = async (args: Record<string, unknown>) => ({ out: `updated=${args.project}` });
	callRunner.register("set_project_status", execute);
	const requested = await callRunner.tool({
		channel: "C1",
		actor: "U_REQUESTER",
		name: "set_project_status",
		args: { project: "mobile-beta" },
		confirm: {
			reason: "Update project status.",
			details: [
				{ label: " Project ", value: "mobile-beta" },
				{ label: "Command", value: "echo ```quoted```", format: "code" },
				{ label: "Huge", value: "x".repeat(3000) },
			],
		},
		execute,
	});

	assert.deepEqual(requested.approval?.details?.slice(0, 2), [
		{ label: "Project", value: "mobile-beta", format: "text" },
		{ label: "Command", value: "echo ```quoted```", format: "code" },
	]);
	assert.equal(requested.approval?.details?.[2]?.value.endsWith("…"), true);
	assert.equal(JSON.parse(approvals.rows[0].details ?? "null")[0].label, "Project");

	const denied = await callRunner.handle({
		kind: "deny",
		approvalId: approvals.rows[0].id,
		channel: "C1",
		actor: "U_ALLOWED",
	});

	assert.equal(denied.approvalResolution, "rejected");
	assert.match(denied.text, /Project:\nmobile-beta/);
	assert.match(denied.text, /Command:\n```\necho `​``quoted`​``\n```/);
	assert.equal(denied.approval?.details?.[0]?.label, "Project");
});

test("malformed persisted approval details are ignored", async () => {
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
		commandConfirm(),
	);

	await callRunner.bash("C1", "U_REQUESTER", "curl https://example.com");
	approvals.rows[0].details = "not json";
	const denied = await callRunner.handle({
		kind: "deny",
		approvalId: approvals.rows[0].id,
		channel: "C1",
		actor: "U_REQUESTER",
	});

	assert.equal(denied.approval?.details, undefined);
	assert.equal(denied.approvalResolution, "rejected");
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
		undefined,
		commandConfirm(),
	);

	await callRunner.bash("C1", "U_REQUESTER", "curl https://example.com");
	const denied = await callRunner.handle({
		kind: "deny",
		approvalId: approvals.rows[0].id,
		channel: "C1",
		actor: "U_ALLOWED",
	});

	assert.match(denied.text, /Approval required/);
	assert.match(denied.text, /curl https:\/\/example.com/);
	assert.doesNotMatch(denied.text, /Use the buttons below/);
	assert.equal(approvals.rows[0].state, "denied");
	assert.equal(
		events.some((event) => event.event === "approval.denied"),
		true,
	);
});

test("approval requester can deny their own pending action", async () => {
	const calls = new FakeCalls();
	const approvals = new FakeApprovals();
	const callRunner = new CallRunner(
		calls,
		approvals,
		new Queue({ maxConcurrent: 1, maxPerChat: 1 }),
		runtime(),
		{ approvers: ["U_ALLOWED"] },
		noLogger(),
		undefined,
		commandConfirm(),
	);

	await callRunner.bash("C1", "U_REQUESTER", "curl https://example.com");
	const denied = await callRunner.handle({
		kind: "deny",
		approvalId: approvals.rows[0].id,
		channel: "C1",
		actor: "U_REQUESTER",
	});

	assert.match(denied.text, /Approval required/);
	assert.equal(approvals.rows[0].state, "denied");
	assert.equal(approvals.rows[0].resolvedBy, "U_REQUESTER");
	assert.equal(calls.rows[0].state, "blocked");
});

test("approval denial rejects actors who are neither approvers nor requesters", async () => {
	const calls = new FakeCalls();
	const approvals = new FakeApprovals();
	const callRunner = new CallRunner(
		calls,
		approvals,
		new Queue({ maxConcurrent: 1, maxPerChat: 1 }),
		runtime(),
		{ approvers: ["U_ALLOWED"] },
		noLogger(),
		undefined,
		commandConfirm(),
	);

	await callRunner.bash("C1", "U_REQUESTER", "curl https://example.com");
	const denied = await callRunner.handle({
		kind: "deny",
		approvalId: approvals.rows[0].id,
		channel: "C1",
		actor: "U_OTHER",
	});

	assert.equal(denied.private, true);
	assert.match(denied.text, /not allowed/i);
	assert.equal(approvals.rows[0].state, "pending");
	assert.equal(calls.rows[0].state, "pending_approval");
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
		undefined,
		commandConfirm(),
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
	assert.equal(approvals.rows[0].state, "expired");
	assert.equal(
		events.some((event) => event.event === "approval.expired"),
		true,
	);
});

test("expired approval can replace the original approval surface", async () => {
	const calls = new FakeCalls();
	const approvals = new FakeApprovals();
	const callRunner = new CallRunner(
		calls,
		approvals,
		new Queue({ maxConcurrent: 1, maxPerChat: 1 }),
		runtime(),
		{ approvers: ["U_ALLOWED"], expiresInMs: -1 },
		noLogger(),
		undefined,
		commandConfirm(),
	);

	await callRunner.bash("C1", "U_REQUESTER", "curl https://example.com");
	let replacement = "";
	const expired = await callRunner.handle(
		{
			kind: "approve",
			approvalId: approvals.rows[0].id,
			channel: "C1",
			actor: "U_ALLOWED",
		},
		{},
		undefined,
		undefined,
		async (out) => {
			replacement = out.text;
		},
	);

	assert.equal(expired.silent, true);
	assert.match(replacement, /Approval expired/);
	assert.match(replacement, /curl https:\/\/example.com/);
	assert.doesNotMatch(replacement, /Use the buttons below/);
	assert.equal(approvals.rows[0].state, "expired");
	assert.equal(calls.rows[0].state, "blocked");
});

test("expired denial can replace the original approval surface", async () => {
	const calls = new FakeCalls();
	const approvals = new FakeApprovals();
	const callRunner = new CallRunner(
		calls,
		approvals,
		new Queue({ maxConcurrent: 1, maxPerChat: 1 }),
		runtime(),
		{ approvers: ["U_ALLOWED"], expiresInMs: -1 },
		noLogger(),
		undefined,
		commandConfirm(),
	);

	await callRunner.bash("C1", "U_REQUESTER", "curl https://example.com");
	let replacement = "";
	const expired = await callRunner.handle(
		{
			kind: "deny",
			approvalId: approvals.rows[0].id,
			channel: "C1",
			actor: "U_ALLOWED",
		},
		{},
		undefined,
		undefined,
		async (out) => {
			replacement = out.text;
		},
	);

	assert.equal(expired.silent, true);
	assert.match(replacement, /Approval expired/);
	assert.match(replacement, /curl https:\/\/example.com/);
	assert.doesNotMatch(replacement, /Use the buttons below/);
	assert.equal(approvals.rows[0].state, "expired");
	assert.equal(calls.rows[0].state, "blocked");
});

test("approval acknowledgement preserves the approved action summary", async () => {
	const calls = new FakeCalls();
	const approvals = new FakeApprovals();
	const callRunner = new CallRunner(
		calls,
		approvals,
		new Queue({ maxConcurrent: 1, maxPerChat: 1 }),
		runtime(),
		{ approvers: ["U_ALLOWED"] },
		noLogger(),
		undefined,
		commandConfirm(),
	);

	await callRunner.bash("C1", "U_REQUESTER", "curl https://example.com");
	let acknowledged = "";
	await callRunner.handle(
		{
			kind: "approve",
			approvalId: approvals.rows[0].id,
			channel: "C1",
			actor: "U_ALLOWED",
		},
		{},
		undefined,
		async (out) => {
			acknowledged = out.text;
		},
	);

	assert.match(acknowledged, /Approval required/);
	assert.match(acknowledged, /curl https:\/\/example.com/);
	assert.doesNotMatch(acknowledged, /Use the buttons below/);
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
		undefined,
		commandConfirm(),
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
	assert.equal(resolved.replaceOriginal, true);
	assert.match(resolved.text, /already denied/);
	assert.equal(
		events.some((event) => event.event === "approval.already_resolved"),
		true,
	);
});

test("missing approval asks adapters to replace stale approval surfaces", async () => {
	const callRunner = new CallRunner(
		new FakeCalls(),
		new FakeApprovals(),
		new Queue({ maxConcurrent: 1, maxPerChat: 1 }),
		runtime(),
		{ approvers: ["U_ALLOWED"] },
		noLogger(),
		undefined,
		commandConfirm(),
	);

	const missing = await callRunner.handle({
		kind: "approve",
		approvalId: "approval-missing",
		channel: "C1",
		actor: "U_ALLOWED",
	});

	assert.equal(missing.private, true);
	assert.equal(missing.replaceOriginal, true);
	assert.match(missing.text, /Approval unavailable/);
});

test("missing approval uses configured system copy", async () => {
	const callRunner = new CallRunner(
		new FakeCalls(),
		new FakeApprovals(),
		new Queue({ maxConcurrent: 1, maxPerChat: 1 }),
		runtime(),
		{ approvers: ["U_ALLOWED"] },
		noLogger(),
		undefined,
		commandConfirm(),
		normalizeMessages({ approvalUnavailable: "That approval is gone." }),
	);

	const missing = await callRunner.handle({
		kind: "deny",
		approvalId: "approval-missing",
		channel: "C1",
		actor: "U_ALLOWED",
	});

	assert.equal(missing.text, "That approval is gone.");
	assert.equal(missing.replaceOriginal, true);
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
		actor: "U_REQUESTER",
		out: "deleted=T1",
		err: "",
		isError: false,
	});
});

class FakeCalls implements Calls {
	readonly rows: Call[] = [];

	async create(input: {
		agent: string;
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
			agent: input.agent,
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
			errKind: null,
			ms: null,
			queueWaitMs: null,
			createdAt: now,
			updatedAt: now,
		};
		this.rows.push(row);
		return row;
	}

	async get(id: string, input: { agent?: string } = {}): Promise<Call | undefined> {
		return this.rows.find((row) => row.id === id && (!input.agent || row.agent === input.agent));
	}

	async getByChannel(channel: string, id: string, input: { agent?: string } = {}): Promise<Call | undefined> {
		return this.rows.find(
			(row) => row.channel === channel && row.id === id && (!input.agent || row.agent === input.agent),
		);
	}

	async listForThread(threadId: string, input: { agent?: string } = {}): Promise<Call[]> {
		return this.rows.filter((row) => row.threadId === threadId && (!input.agent || row.agent === input.agent));
	}

	async setState(id: string, state: CallState, input: { agent?: string } = {}): Promise<void> {
		const row = await this.get(id, input);
		if (row) row.state = state;
	}

	async finish(
		id: string,
		input: {
			state: CallState;
			code: number;
			out: string;
			err: string;
			errKind?: CallErrorKind;
			ms: number;
			queueWaitMs: number;
		},
	): Promise<void> {
		const row = await this.get(id);
		if (!row) return;
		row.state = input.state;
		row.code = input.code;
		row.out = input.out;
		row.err = input.err;
		row.errKind = input.errKind ?? null;
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
		agent: string;
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
		details?: string;
	}): Promise<Approval> {
		const row: Approval = {
			id: `approval-${this.rows.length + 1}`,
			agent: input.agent,
			callId: input.callId,
			channel: input.channel,
			threadId: input.threadId ?? null,
			turnId: input.turnId ?? null,
			requestMessageId: input.requestMessageId ?? null,
			command: input.command,
			runtime: input.runtime,
			reason: input.reason,
			details: input.details ?? null,
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

	async get(id: string, input: { agent?: string } = {}): Promise<Approval | undefined> {
		return this.rows.find((row) => row.id === id && (!input.agent || row.agent === input.agent));
	}

	async getByChannel(channel: string, id: string, input: { agent?: string } = {}): Promise<Approval | undefined> {
		return this.rows.find(
			(row) => row.channel === channel && row.id === id && (!input.agent || row.agent === input.agent),
		);
	}

	async getPending(channel: string, id: string, input: { agent?: string } = {}): Promise<Approval | undefined> {
		return this.rows.find(
			(row) =>
				row.channel === channel &&
				row.id === id &&
				row.state === "pending" &&
				(!input.agent || row.agent === input.agent),
		);
	}

	async listPending(input: { agent?: string; threadId?: string; turnId?: string } = {}): Promise<Approval[]> {
		return this.rows.filter(
			(row) =>
				row.state === "pending" &&
				(!input.agent || row.agent === input.agent) &&
				(!input.threadId || row.threadId === input.threadId) &&
				(!input.turnId || row.turnId === input.turnId),
		);
	}

	async resolve(
		id: string,
		state: "approved" | "denied" | "expired",
		actor: string,
		input: { agent?: string } = {},
	): Promise<boolean> {
		const row = await this.get(id, input);
		if (!row || row.state !== "pending") return false;
		row.state = state;
		row.resolvedBy = actor;
		row.resolvedAt = Date.now();
		return true;
	}
}

class FakeBypasses implements ApprovalBypasses {
	readonly rows: ApprovalBypass[] = [];

	async create(input: {
		agent: string;
		scope: "thread" | "channel" | "user" | "adapter";
		channel: string;
		threadId?: string;
		actor?: string;
		createdBy: string;
		reason?: string;
		approvalId?: string;
		expiresAt: number;
	}): Promise<ApprovalBypass> {
		const row: ApprovalBypass = {
			id: `bypass-${this.rows.length + 1}`,
			agent: input.agent,
			scope: input.scope,
			channel: input.channel,
			threadId: input.threadId ?? null,
			actor: input.actor ?? null,
			createdBy: input.createdBy,
			reason: input.reason ?? null,
			approvalId: input.approvalId ?? null,
			createdAt: Date.now(),
			expiresAt: input.expiresAt,
			revokedAt: null,
			revokedBy: null,
		};
		this.rows.push(row);
		return row;
	}

	async active(input: {
		agent: string;
		channel: string;
		threadId?: string;
		actor?: string;
		now?: number;
	}): Promise<ApprovalBypass | undefined> {
		const now = input.now ?? Date.now();
		const adapter = input.channel.split(":")[0];
		return this.rows.find((row) => {
			if (row.agent !== input.agent || row.revokedAt || row.expiresAt <= now) return false;
			if (row.scope === "adapter") return row.channel.startsWith(`${adapter}:`);
			if (row.scope === "channel") return row.channel === input.channel;
			if (row.scope === "thread") return row.threadId === input.threadId;
			if (row.scope === "user") return row.actor === input.actor;
			return false;
		});
	}

	async listActive(): Promise<ApprovalBypass[]> {
		return this.rows.filter((row) => !row.revokedAt && row.expiresAt > Date.now());
	}

	async revoke(id: string, actor: string, input: { agent?: string } = {}): Promise<boolean> {
		const row = this.rows.find(
			(item) => item.id === id && !item.revokedAt && (!input.agent || item.agent === input.agent),
		);
		if (!row) return false;
		row.revokedAt = Date.now();
		row.revokedBy = actor;
		return true;
	}
}
