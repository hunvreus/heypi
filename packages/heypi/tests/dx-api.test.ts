import assert from "node:assert/strict";
import { test } from "node:test";
import type {
	DefaultToolConfig,
	DefaultToolDefinition,
	DefaultToolName,
	DefaultToolOption,
	DefaultToolsConfig,
} from "../src/api.js";
import { approval, defaultTools, defineEval, evaluateEval } from "../src/api.js";
import { evalExpectDetail, evalExpectLabel, evalExpectSummary } from "../src/eval.js";

test("defaultTools exports preferred public type names", () => {
	const tool: DefaultToolConfig = { confirm: approval.never() };
	const disabled: DefaultToolOption = false;
	const config: DefaultToolsConfig = { bash: tool, write: false };
	assert.equal(disabled, false);
	const names: DefaultToolName[] = defaultTools(config).map((row: DefaultToolDefinition) => row.name);
	assert.deepEqual(names, ["history", "bash", "read", "edit", "grep", "find", "ls", "attach"]);
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

test("eval expectation display helpers handle summaries, labels, and details", () => {
	const expect = [{ tool: "hosts_list" }, { includes: "prod", text: /deployed/i }, async () => undefined];

	assert.deepEqual(evalExpectSummary(expect), [
		{ tool: "hosts_list" },
		{ includes: "prod", text: "/deployed/i" },
		"custom",
	]);
	assert.equal(evalExpectLabel(expect), "tool:hosts_list, includes:prod+text:/deployed/i, custom");
	assert.equal(evalExpectDetail(expect), "1. tool:hosts_list\n2. includes:prod+text:/deployed/i\n3. custom");
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
