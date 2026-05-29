import assert from "node:assert/strict";
import { test } from "node:test";
import { DeliveryQueue } from "../src/io/delivery.js";

test("DeliveryQueue serializes calls with a minimum interval", async () => {
	const queue = new DeliveryQueue({ intervalMs: 20, retries: 0 });
	const starts: number[] = [];

	await Promise.all([
		queue.run(async () => {
			starts.push(Date.now());
		}),
		queue.run(async () => {
			starts.push(Date.now());
		}),
	]);

	assert.equal(starts.length, 2);
	assert.ok(starts[1] - starts[0] >= 15);
});

test("DeliveryQueue retries transient delivery failures", async () => {
	const queue = new DeliveryQueue({ intervalMs: 0, retries: 1, baseMs: 1 });
	let attempts = 0;

	const out = await queue.run(async () => {
		attempts++;
		if (attempts === 1) throw new Error("429 rate limited");
		return "ok";
	});

	assert.equal(out, "ok");
	assert.equal(attempts, 2);
});

test("DeliveryQueue does not retry ambiguous send timeouts", async () => {
	const queue = new DeliveryQueue({ intervalMs: 0, retries: 2, baseMs: 1 });
	let attempts = 0;

	await assert.rejects(
		() =>
			queue.run(
				async () => {
					attempts++;
					throw new Error("timeout");
				},
				{ retry: "send" },
			),
		/timeout/,
	);

	assert.equal(attempts, 1);
});
