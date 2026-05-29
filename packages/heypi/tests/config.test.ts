import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { agentFrom, DEFAULT_SOUL, modelConfig } from "../src/config.js";
import { renderCall } from "../src/core/format.js";
import { normalizeMessages } from "../src/core/messages.js";
import { RUNTIME_STARTUP_ERROR_KIND } from "../src/runtime/errors.js";
import { approvalFromMessages, renderContextBlock, runtimeSystemPrompt } from "../src/runtime/pi-agent.js";

test("agentFrom requires an explicit model or HEYPI_MODEL", () => {
	const previous = process.env.HEYPI_MODEL;
	delete process.env.HEYPI_MODEL;
	try {
		assert.throws(() => agentFrom("../../examples/slack-devops/agent"), /model is required/);
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

test("agentFrom loads SOUL.md separately from AGENTS.md and SYSTEM.md", () => {
	const root = join(tmpdir(), `heypi-agent-${Date.now()}-${Math.random().toString(16).slice(2)}`);
	mkdirSync(root, { recursive: true });
	writeFileSync(join(root, "SOUL.md"), "voice");
	writeFileSync(join(root, "AGENTS.md"), "ops");
	writeFileSync(join(root, "SYSTEM.md"), "runtime");

	const agent = agentFrom(root, { model: "openai/gpt-5-mini" });
	assert.equal(agent.soul, "voice");
	assert.equal(agent.prompt, "ops");
	assert.equal(agent.systemPrompt, "runtime");
});

test("agentFrom uses a default SOUL.md fallback", () => {
	const root = mkdtempSync(join(tmpdir(), "heypi-agent-"));
	const agent = agentFrom(root, { model: "openai/gpt-5-mini" });
	assert.equal(agent.soul, DEFAULT_SOUL);
});

test("runtimeSystemPrompt generates core tool guidance from active tools", () => {
	assert.match(runtimeSystemPrompt(["bash", "read", "grep"]), /prefer them over shell commands/i);
	assert.match(runtimeSystemPrompt(["bash"]), /shell commands and file exploration/i);
	assert.doesNotMatch(runtimeSystemPrompt(["read"]), /shell commands/i);
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
