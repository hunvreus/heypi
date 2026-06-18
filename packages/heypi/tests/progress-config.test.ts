import assert from "node:assert/strict";
import { test } from "node:test";
import { normalizeProgressConfig } from "../src/io/progress-config.js";

test("progress config normalization disables progress when false", () => {
	assert.equal(normalizeProgressConfig(false), undefined);
});

test("progress config normalization defaults missing config to immediate progress", () => {
	assert.deepEqual(normalizeProgressConfig(undefined), { delayMs: 0 });
});

test("progress config normalization preserves provider-specific progress fields", () => {
	assert.deepEqual(normalizeProgressConfig({ message: "Working", reaction: "eyes", delayMs: 500 }), {
		message: "Working",
		reaction: "eyes",
		delayMs: 500,
	});
});
