import assert from "node:assert/strict";
import { test } from "node:test";
import { ActiveRuns } from "../src/core/active.js";
import { parseIntent } from "../src/core/intent.js";
import { Queue } from "../src/runtime/queue.js";

test("parseIntent recognizes cancel commands", () => {
	assert.deepEqual(parseIntent({ text: "cancel trace-1", channel: "C1", actor: "U1" }), {
		kind: "cancel",
		id: "trace-1",
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
