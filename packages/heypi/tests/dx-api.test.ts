import assert from "node:assert/strict";
import { test } from "node:test";
import { approval, defaultTools, defineEval } from "../src/api.js";
import { coreTools } from "../src/core-tools.js";

test("defaultTools preserves the existing coreTools behavior", () => {
	assert.deepEqual(
		defaultTools().map((tool) => tool.name),
		coreTools().map((tool) => tool.name),
	);
	assert.equal(defaultTools().find((tool) => tool.name === "bash")?.confirm !== undefined, true);
});

test("approval helpers create common confirmation policies", () => {
	assert.deepEqual(approval.always("Ship it"), { message: "Ship it" });
	assert.equal(typeof approval.never(), "function");
	assert.equal(
		typeof approval.when((input: { env?: string }) => input.env === "prod", "Production change"),
		"function",
	);

	const never = approval.never();
	assert.equal(never({}), false);

	const prodOnly = approval.when((input: { env?: string }) => input.env === "prod", "Production change");
	assert.deepEqual(prodOnly({ env: "prod" }), { message: "Production change" });
	assert.equal(prodOnly({ env: "dev" }), false);
});

test("approval.command delegates to command policy confirmation", () => {
	const confirm = approval.command({ approve: [/deploy/] });
	assert.deepEqual(confirm({ command: "deploy prod" }), {
		message: "Run bash command.",
		policyReason: "approval by /deploy/",
		details: [{ label: "Command", value: "deploy prod", format: "code" }],
	});
});

test("defineEval preserves behavior eval definitions", () => {
	const evaluation = defineEval({
		name: "lists hosts",
		tags: ["smoke"],
		prompt: "List configured hosts.",
		expect: { tool: "hosts_list" },
	});
	assert.equal(evaluation.name, "lists hosts");
	assert.deepEqual(evaluation.tags, ["smoke"]);
	assert.deepEqual(evaluation.expect, { tool: "hosts_list" });
});
