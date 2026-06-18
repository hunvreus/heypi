import assert from "node:assert/strict";
import { test } from "node:test";
import { delayedProgressPlaceholder } from "../src/io/progress-placeholder.js";

test("delayed progress placeholder sends the latest text and can be taken", async () => {
	const sent: string[] = [];
	const placeholder = delayedProgressPlaceholder({
		message: "Working...",
		delayMs: 0,
		send: async (text) => {
			sent.push(text);
			return "message-1";
		},
		onError: () => undefined,
	});

	assert.equal(placeholder.setText("Still working..."), undefined);
	await new Promise((resolve) => setTimeout(resolve, 0));
	assert.equal(await placeholder.take(), "message-1");
	assert.deepEqual(sent, ["Still working..."]);
	assert.equal(await placeholder.take(), undefined);
});

test("delayed progress placeholder can be cancelled before sending", async () => {
	const sent: string[] = [];
	const placeholder = delayedProgressPlaceholder({
		message: "Working...",
		delayMs: 10_000,
		send: async (text) => {
			sent.push(text);
			return "message-1";
		},
		onError: () => undefined,
	});

	assert.equal(await placeholder.clear(), undefined);
	assert.deepEqual(sent, []);
});

test("disabled delayed progress placeholder ignores text updates", async () => {
	const placeholder = delayedProgressPlaceholder({
		message: false,
		delayMs: 0,
		send: async () => "message-1",
		onError: () => undefined,
	});

	assert.equal(placeholder.setText("Still working..."), undefined);
	assert.equal(await placeholder.take(), undefined);
});
