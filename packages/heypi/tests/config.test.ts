import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { DEFAULT_AGENT_ID, DEFAULT_INSTRUCTIONS, loadAgent, loadPrompt, modelConfig } from "../src/config.js";
import { renderCall } from "../src/core/format.js";
import { normalizeMessages } from "../src/core/messages.js";
import { defaultTools } from "../src/core-tools.js";
import { RUNTIME_STARTUP_ERROR_KIND } from "../src/runtime/errors.js";
import {
	approvalFromMessages,
	channelContext,
	renderContextBlock,
	runtimeSystemPrompt,
} from "../src/runtime/pi-agent.js";
import { defineTool } from "../src/tool.js";
import { toolConfirm, toolPiRunner, toolRunner } from "../src/tool-internal.js";

test("loadAgent requires an explicit model or HEYPI_MODEL", () => {
	const previous = process.env.HEYPI_MODEL;
	delete process.env.HEYPI_MODEL;
	try {
		assert.throws(() => loadAgent("../../examples/slack-devops/agent"), /model is required/);
	} finally {
		if (previous === undefined) delete process.env.HEYPI_MODEL;
		else process.env.HEYPI_MODEL = previous;
	}
});

test("modelConfig preserves explicit verbosity", () => {
	assert.deepEqual(modelConfig({ provider: "openai", name: "gpt-5-mini", verbosity: "low" }), {
		provider: "openai",
		name: "gpt-5-mini",
		verbosity: "low",
	});
});

test("loadAgent loads instructions.md and system.md", () => {
	const root = join(tmpdir(), `heypi-agent-${Date.now()}-${Math.random().toString(16).slice(2)}`);
	mkdirSync(root, { recursive: true });
	writeFileSync(join(root, "instructions.md"), "ops");
	writeFileSync(join(root, "system.md"), "runtime");

	const agent = loadAgent(root, { model: "openai/gpt-5-mini" });
	assert.equal(agent.instructions, "ops");
	assert.equal(agent.systemPrompt, "runtime");
});

test("loadAgent uses default instructions fallback", () => {
	const root = mkdtempSync(join(tmpdir(), "heypi-agent-"));
	const agent = loadAgent(root, { model: "openai/gpt-5-mini" });
	assert.equal(agent.instructions, DEFAULT_INSTRUCTIONS);
});

test("loadPrompt throws for explicit missing files unless optional", () => {
	const root = mkdtempSync(join(tmpdir(), "heypi-agent-"));
	assert.throws(() => loadPrompt(join(root, "missing.md")), /prompt file not found/);
	assert.equal(loadPrompt(join(root, "missing.md"), { optional: true }), undefined);
});

test("loadAgent defaults to the canonical agent id", () => {
	const root = mkdtempSync(join(tmpdir(), "heypi-agent-"));
	assert.equal(loadAgent(root, { model: "openai/gpt-5-mini" }).id, DEFAULT_AGENT_ID);
	assert.equal(loadAgent(root, { id: "ops", model: "openai/gpt-5-mini" }).id, "ops");
});

test("loadAgent preserves configured dynamic context providers", () => {
	const root = mkdtempSync(join(tmpdir(), "heypi-agent-"));
	const provider = async () => ({ title: "Request context", text: "channel=C1" });
	const agent = loadAgent(root, { model: "openai/gpt-5-mini", context: [provider] });
	assert.equal(agent.context?.[0], provider);
});

test("loadAgent discovers tools and jobs from agent folders", () => {
	const root = mkdtempSync(join(tmpdir(), "heypi-agent-"));
	mkdirSync(join(root, "tools"), { recursive: true });
	mkdirSync(join(root, "tools", "github"), { recursive: true });
	mkdirSync(join(root, "jobs"), { recursive: true });
	mkdirSync(join(root, "jobs", "ops"), { recursive: true });
	writeFileSync(
		join(root, "tools", "lookup.ts"),
		[
			`import { defineTool } from ${JSON.stringify(modulePath("src/tool.ts"))};`,
			'export default defineTool({ description: "Lookup.", input: { type: "object", properties: { name: { type: "string" } }, required: ["name"] }, run: async ({ name }) => "name=" + name });',
		].join("\n"),
	);
	writeFileSync(
		join(root, "tools", "github", "repos.ts"),
		[
			`import { defineTool } from ${JSON.stringify(modulePath("src/tool.ts"))};`,
			'export default defineTool({ description: "Repos.", input: { type: "object", properties: {} }, run: async () => "repos" });',
		].join("\n"),
	);
	writeFileSync(
		join(root, "jobs", "daily.ts"),
		[
			`import { defineJob } from ${JSON.stringify(modulePath("src/job.ts"))};`,
			'export default defineJob({ id: "daily", everyMs: 60_000, targets: { test: { channels: ["C1"] } }, prompt: "check" });',
		].join("\n"),
	);
	writeFileSync(
		join(root, "jobs", "ops", "hourly.ts"),
		[
			`import { defineJob } from ${JSON.stringify(modulePath("src/job.ts"))};`,
			'export default defineJob({ id: "hourly", everyMs: 3_600_000, targets: { test: { channels: ["C1"] } }, prompt: "hourly" });',
		].join("\n"),
	);
	const agent = loadAgent(root, { model: "openai/gpt-5-mini" });
	assert.deepEqual(
		agent.builtinTools?.map((tool) => tool.name),
		["history", "bash", "read", "write", "edit", "grep", "find", "ls", "attach"],
	);
	assert.deepEqual(
		agent.tools?.map((tool) => tool.name),
		["repos", "lookup"],
	);
	assert.deepEqual(
		agent.jobs?.map((job) => job.id),
		["daily", "hourly"],
	);
	assert.equal(agent.evals, undefined);
});

test("loadAgent discovers Telegram example tools from agent/tools", () => {
	const agent = loadAgent("../../examples/telegram-workout/agent", { model: "openai/gpt-5-mini" });
	assert.deepEqual(
		agent.tools?.map((tool) => tool.name),
		["get_profile", "save_profile", "log_workout"],
	);
});

test("loadAgent discovers webhook GitHub example tools from agent/tools", () => {
	const previous = process.env.HEYPI_INTERNAL_DEV;
	process.env.HEYPI_INTERNAL_DEV = "1";
	try {
		const agent = loadAgent("../../examples/webhook-github-docker/agent", { model: "openai/gpt-5-mini" });
		assert.deepEqual(
			agent.tools?.map((tool) => tool.name),
			["github_issue_get", "github_issue_search", "github_issue_comment", "github_issue_close_duplicate"],
		);
	} finally {
		if (previous === undefined) delete process.env.HEYPI_INTERNAL_DEV;
		else process.env.HEYPI_INTERNAL_DEV = previous;
	}
});

test("loadAgent preserves heypi tool metadata across package import paths", () => {
	const agent = loadAgent("../../examples/slack-devops/agent", { model: "openai/gpt-5-mini" });
	const tool = agent.tools?.find((item) => item.name === "host_exec");
	assert.ok(tool);
	assert.equal(typeof toolConfirm(tool), "function");
	assert.equal(typeof toolRunner(tool), "function");
	assert.equal(typeof toolPiRunner(tool), "function");
});

test("loadAgent options override convention folders by category", () => {
	const root = mkdtempSync(join(tmpdir(), "heypi-agent-"));
	mkdirSync(join(root, "tools"), { recursive: true });
	mkdirSync(join(root, "jobs"), { recursive: true });
	writeFileSync(
		join(root, "tools", "lookup.ts"),
		[
			`import { defineTool } from ${JSON.stringify(modulePath("src/tool.ts"))};`,
			'export default defineTool({ description: "Lookup.", input: { type: "object", properties: {} }, run: async () => "ok" });',
		].join("\n"),
	);
	writeFileSync(
		join(root, "jobs", "daily.ts"),
		[
			`import { defineJob } from ${JSON.stringify(modulePath("src/job.ts"))};`,
			'export default defineJob({ id: "daily", everyMs: 60_000, targets: { test: { channels: ["C1"] } }, prompt: "check" });',
		].join("\n"),
	);

	const agent = loadAgent(root, {
		model: "openai/gpt-5-mini",
		tools: [defineTool({ name: "inline", description: "Explicit.", input: {}, run: async () => "ok" })],
		jobs: [],
	});
	assert.deepEqual(
		agent.tools?.map((tool) => tool.name),
		["inline"],
	);
	assert.deepEqual(agent.jobs, []);
});

test("loadAgent rejects legacy defaultTools entries in tools", () => {
	const root = mkdtempSync(join(tmpdir(), "heypi-agent-"));
	assert.throws(
		() =>
			loadAgent(root, {
				model: "openai/gpt-5-mini",
				tools: defaultTools() as never,
			}),
		/defaultTools\(\) entries must be configured with builtinTools, not tools/,
	);
});

function modulePath(path: string): string {
	return join(process.cwd(), path);
}

test("runtimeSystemPrompt generates core tool guidance from active tools", () => {
	assert.match(runtimeSystemPrompt(["bash", "read", "grep"]), /prefer them over shell commands/i);
	assert.match(runtimeSystemPrompt(["bash"]), /shell commands and file exploration/i);
	assert.doesNotMatch(runtimeSystemPrompt(["read"]), /shell commands/i);
});

test("runtimeSystemPrompt tells attach-capable agents to attach file-like output", () => {
	const prompt = runtimeSystemPrompt(["attach"]);
	assert.match(prompt, /Prefer attachments for content that is long, structured/);
	assert.match(prompt, /easier to inspect as a file/);
});

test("channelContext tells chat agents to avoid pasting large file-like content", () => {
	const context = channelContext({
		provider: "discord",
		channel: "C1",
		actor: "U1",
		threadId: "thread-1",
	});
	assert.match(context ?? "", /Keep chat replies concise/);
	assert.match(context ?? "", /save it as a file and attach it instead of pasting the full content/);
	assert.match(context ?? "", /Provider: discord/);
});

test("renderContextBlock formats dynamic agent context", () => {
	assert.equal(renderContextBlock(" hello "), "hello");
	assert.equal(renderContextBlock({ title: "Known hosts", text: "- db-1" }), "## Known hosts\n\n- db-1");
	assert.equal(renderContextBlock({ title: "Empty", text: " " }), undefined);
	assert.equal(renderContextBlock(false), undefined);
});

test("renderCall formats confirmed tool arguments for approvals", () => {
	const out = renderCall({
		callId: "call-1",
		state: "pending_approval",
		approvalId: "approval-1",
		runtime: "tool",
		reason: "Check host uptime.",
		command: 'host_exec {"hosts":["web-1"],"purpose":"Check host uptime.","command":"hostname && uptime"}',
		details: [
			{ label: "Target", value: "web-1" },
			{ label: "Command", value: "hostname && uptime", format: "code" },
		],
	});

	assert.doesNotMatch(out.text, /Action: `host_exec`/);
	assert.match(out.text, /Check host uptime/);
	assert.match(out.text, /Target:\nweb-1/);
	assert.match(out.text, /Command:\n```\nhostname && uptime\n```/);
	assert.doesNotMatch(out.text, /host_exec \\{/);
	assert.doesNotMatch(out.text, /purpose/);
	assert.doesNotMatch(out.text, /Use the buttons below/);
});

test("renderCall hides runtime startup details from chat output", () => {
	const out = renderCall({
		callId: "call-1",
		state: "failed",
		code: 1,
		err: "container could not boot: daemon unavailable",
		errKind: RUNTIME_STARTUP_ERROR_KIND,
		messages: normalizeMessages({ runtimeFailed: "Runtime unavailable." }),
	});

	assert.match(out.text, /Runtime unavailable\./);
	assert.doesNotMatch(out.text, /container could not boot|daemon unavailable/);
});

test("approvalFromMessages extracts approval metadata from terminated tool results", () => {
	assert.deepEqual(
		approvalFromMessages([
			{
				role: "toolResult",
				toolCallId: "tool-call-1",
				toolName: "delete_ticket",
				content: [{ type: "text", text: "approval required" }],
				details: {
					state: "pending_approval",
					approval: {
						id: "approval-1",
						callId: "call-1",
						command: "delete_ticket",
						runtime: "tool",
						reason: "delete",
						allowed: ["U1"],
					},
				},
				timestamp: Date.now(),
			} as never,
		]),
		{
			id: "approval-1",
			callId: "call-1",
			command: "delete_ticket",
			runtime: "tool",
			reason: "delete",
			allowed: ["U1"],
		},
	);
});
