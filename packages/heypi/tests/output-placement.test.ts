import assert from "node:assert/strict";
import { test } from "node:test";
import { dispatchPlacement, outputPlacement } from "../src/io/output-placement.js";
import type { ReplyStream } from "../src/io/reply-stream.js";

const completeStream = { complete: () => true } as ReplyStream;
const incompleteStream = { complete: () => false } as ReplyStream;

test("output placement sends explicit thread placement as a fresh reply", () => {
	assert.equal(outputPlacement({ finalPlacement: "thread" }, completeStream), "fresh");
	assert.equal(outputPlacement({ finalPlacement: "thread", approval: approval() }, incompleteStream), "fresh");
});

test("output placement treats completed non-approval streams as already sent", () => {
	assert.equal(outputPlacement({}, completeStream), "streamed");
});

test("output placement uses progress update for approvals and incomplete streams", () => {
	assert.equal(outputPlacement({ approval: approval() }, completeStream), "progress");
	assert.equal(outputPlacement({}, incompleteStream), "progress");
	assert.equal(outputPlacement({ finalPlacement: "progress" }), "progress");
});

function approval() {
	return {
		id: "approval",
		callId: "call",
		command: "true",
		runtime: "test",
		reason: "test",
		allowed: [],
	};
}

test("dispatch placement calls exactly the selected handler", async () => {
	const calls: string[] = [];
	await dispatchPlacement({ finalPlacement: "thread" }, completeStream, {
		fresh: () => calls.push("fresh"),
		streamed: () => calls.push("streamed"),
		progress: () => calls.push("progress"),
	});
	await dispatchPlacement({}, completeStream, {
		fresh: () => calls.push("fresh"),
		streamed: () => calls.push("streamed"),
		progress: () => calls.push("progress"),
	});
	await dispatchPlacement({}, incompleteStream, {
		fresh: () => calls.push("fresh"),
		streamed: () => calls.push("streamed"),
		progress: () => calls.push("progress"),
	});

	assert.deepEqual(calls, ["fresh", "streamed", "progress"]);
});
