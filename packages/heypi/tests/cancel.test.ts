import assert from "node:assert/strict";
import { test } from "node:test";
import { ActiveRuns, isAbortError } from "../src/core/active.js";
import { parseIntent } from "../src/core/intent.js";
import { Queue } from "../src/runtime/queue.js";

test("parseIntent recognizes cancel commands", () => {
	assert.deepEqual(parseIntent({ text: "/cancel trace-1", channel: "C1", actor: "U1" }), {
		kind: "cancel",
		id: "trace-1",
		channel: "C1",
		actor: "U1",
	});
});

test("parseIntent treats incomplete control commands as help", () => {
	for (const text of ["/approve", "/deny", "/cancel", "/revoke", "/bash"]) {
		assert.deepEqual(parseIntent({ text, channel: "C1", actor: "U1" }), { kind: "help" });
	}
});

test("parseIntent recognizes approval bypass and revoke commands", () => {
	assert.deepEqual(parseIntent({ text: "/approve approval-1 bypass", channel: "C1", actor: "U1" }), {
		kind: "approve",
		approvalId: "approval-1",
		channel: "C1",
		actor: "U1",
		bypass: true,
	});
	assert.deepEqual(parseIntent({ text: "/revoke bypass-1", channel: "C1", actor: "U1" }), {
		kind: "revoke",
		bypassId: "bypass-1",
		channel: "C1",
		actor: "U1",
	});
});

test("parseIntent treats bare control words as agent prompts", () => {
	assert.deepEqual(parseIntent({ text: "approve appr_123", channel: "C1", actor: "U1" }), {
		kind: "ask",
		text: "approve appr_123",
		channel: "C1",
		actor: "U1",
	});
});

test("ActiveRuns cancels all aliases for a run", () => {
	const active = new ActiveRuns();
	const run = active.start(["trace-1", "turn-1"]);

	assert.equal(active.cancel("trace-1"), "cancelled");
	assert.equal(run.signal.aborted, true);
	assert.equal(active.cancel("turn-1"), "not_found");
});

test("ActiveRuns drains active runs and aborts survivors", async () => {
	const active = new ActiveRuns();
	const run = active.start(["trace-1"]);

	assert.equal(active.count(), 1);
	assert.equal(await active.drain(1), false);
	assert.equal(active.abortAll(), 1);
	assert.equal(run.signal.aborted, true);
	assert.equal(active.count(), 1);
	run.stop();
	assert.equal(await active.drain(1), true);
	assert.equal(active.count(), 0);
});

test("isAbortError only matches explicit abort errors", () => {
	assert.equal(isAbortError(new DOMException("This operation was aborted", "AbortError")), true);
	assert.equal(isAbortError(new Error("Failed to cancel previous turn")), false);
	assert.equal(isAbortError(new Error("provider cancellation policy rejected request")), false);
});

test("Queue rejects pending jobs immediately when cancelled", async () => {
	const queue = new Queue({ maxConcurrent: 1, maxPerChat: 1 });
	let release: (() => void) | undefined;
	const first = queue.submit(
		"C1",
		() =>
			new Promise<string>((resolve) => {
				release = () => resolve("first");
			}),
	);
	const controller = new AbortController();
	const second = queue.submit("C1", async () => "second", controller.signal);

	controller.abort();
	await assert.rejects(second, /cancelled/);
	release?.();
	const out = await first;
	assert.equal(out.result, "first");
	assert.equal(typeof out.waitMs, "number");
});
