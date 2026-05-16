import assert from "node:assert/strict";
import { test } from "node:test";
import { classifyCommand } from "@hunvreus/heypi";

test("command classification blocks rm -rf root even when followed by more shell", () => {
	assert.equal(classifyCommand("rm -rf /").risk, "block");
	assert.equal(classifyCommand("rm -rf / && echo done").risk, "block");
});

test("command classification supports additive allow, approval, and block patterns", () => {
	assert.deepEqual(classifyCommand("curl -I https://example.com", { allow: [/^curl -I /] }), {
		risk: "allow",
		reason: "allowed by /^curl -I /",
	});
	assert.deepEqual(classifyCommand("make deploy", { approve: [/make deploy/] }), {
		risk: "approval",
		reason: "approval by /make deploy/",
	});
	assert.deepEqual(classifyCommand("gh repo delete test", { block: [/gh repo delete/] }), {
		risk: "block",
		reason: "blocked by /gh repo delete/",
	});
});

test("command classification handles stateful regex flags deterministically", () => {
	const allow = /^curl -I /g;
	assert.equal(classifyCommand("curl -I https://example.com", { allow: [allow] }).risk, "allow");
	assert.equal(classifyCommand("curl -I https://example.com", { allow: [allow] }).risk, "allow");

	const block = /gh repo delete/y;
	assert.equal(classifyCommand("gh repo delete test", { block: [block] }).risk, "block");
	assert.equal(classifyCommand("gh repo delete test", { block: [block] }).risk, "block");
});
