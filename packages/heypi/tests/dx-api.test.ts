import assert from "node:assert/strict";
import { test } from "node:test";
import { approval, defaultTools, defineEval, evaluateEval } from "../src/api.js";
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

test("evaluateEval checks text, tool, and approval assertions", async () => {
	const report = await evaluateEval(
		{
			expect: [
				{ includes: "prod", tool: "hosts_list" },
				{ text: /deployed/i, approval: "approval-1" },
			],
		},
		{
			text: "prod deployed.",
			tools: ["hosts_list"],
			approvals: ["approval-1"],
		},
	);
	assert.equal(report.ok, true);
	assert.deepEqual(
		report.assertions.map((row) => [row.label, row.ok]),
		[
			["includes", true],
			["tool", true],
			["text", true],
			["approval", true],
		],
	);
});

test("evaluateEval reports failed assertions without throwing", async () => {
	const report = await evaluateEval(
		{ expect: [{ text: "done", tool: "deploy", approval: false }] },
		{ text: "blocked", tools: ["plan"], approvals: ["approval-1"] },
	);
	assert.equal(report.ok, false);
	assert.deepEqual(
		report.assertions.map((row) => [row.label, row.ok]),
		[
			["text", false],
			["tool", false],
			["approval", false],
		],
	);
	assert.match(report.assertions[0]?.message ?? "", /expected text/);
});

test("evaluateEval converts custom assertion failures into reports", async () => {
	const report = await evaluateEval(
		{
			expect: async () => {
				throw new Error("missing fixture");
			},
		},
		{ text: "", tools: [], approvals: [] },
	);
	assert.deepEqual(report, {
		ok: false,
		assertions: [{ ok: false, label: "custom", message: "missing fixture" }],
	});
});
