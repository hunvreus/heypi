import assert from "node:assert/strict";
import { test } from "node:test";
import { decidePolicy } from "../src/core/policy.js";

test("policy blocks rm -rf root even when followed by more shell", () => {
	assert.equal(decidePolicy("rm -rf /").kind, "block");
	assert.equal(decidePolicy("rm -rf / && echo done").kind, "block");
});
