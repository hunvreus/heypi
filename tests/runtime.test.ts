import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { ToolDefinition } from "@mariozechner/pi-coding-agent";
import type { Logger } from "../src/core/log.js";
import type { Confirm } from "../src/core/types.js";
import { hostBash } from "../src/runtime/host-bash.js";
import { justBash } from "../src/runtime/just-bash.js";
import { tools } from "../src/runtime/tools.js";
import type { Runtime } from "../src/runtime/types.js";
import type { HistoryMessage, Message, Messages } from "../src/store/types.js";
import { tool } from "../src/tool.js";

async function temp(): Promise<string> {
	return await mkdtemp(join(tmpdir(), "heypi-test-"));
}

test("just-bash runtime persists files and exposes file operations", async () => {
	const root = await temp();
	try {
		const runtime = justBash({ root });
		const bash = await runtime.bash?.({ command: "mkdir -p src && echo hello > src/a.txt && cat src/a.txt" });
		assert.equal(bash?.code, 0);
		assert.equal(bash?.out, "hello\n");

		const read = await runtime.read?.({ path: "src/a.txt" });
		assert.equal(read?.text, "hello\n");

		const list = await runtime.ls?.({ path: "src" });
		assert.deepEqual(
			list?.entries.map((entry) => [entry.type, entry.path]),
			[["file", "src/a.txt"]],
		);

		const grep = await runtime.grep?.({ query: "hello" });
		assert.deepEqual(grep?.hits, [{ path: "src/a.txt", line: 1, text: "hello" }]);

		const found = await runtime.find?.({ pattern: "**/*.txt" });
		assert.deepEqual(found?.paths, ["src/a.txt"]);
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});

test("runtime file tools enforce size limits", async () => {
	const root = await temp();
	try {
		const runtime = hostBash({ root, limits: { maxFileBytes: 4, maxScanBytes: 8, maxEntries: 10 } });
		await writeFile(join(root, "big.txt"), "hello", "utf8");

		await assert.rejects(() => runtime.read!({ path: "big.txt" }), /exceeds limit/);
		await assert.rejects(() => runtime.write!({ path: "big.txt", content: "hello" }), /exceeds limit/);
		await assert.rejects(() => runtime.edit!({ path: "big.txt", oldText: "h", newText: "H" }), /exceeds limit/);
		await assert.rejects(() => runtime.grep!({ query: "hello" }), /exceeds limit/);
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});

test("just-bash file tools enforce write and edit size limits", async () => {
	const root = await temp();
	try {
		const runtime = justBash({ root, limits: { maxFileBytes: 4 } });
		await writeFile(join(root, "small.txt"), "hey", "utf8");
		await writeFile(join(root, "big.txt"), "hello", "utf8");

		await assert.rejects(() => runtime.write!({ path: "big.txt", content: "hello" }), /exceeds limit/);
		await assert.rejects(() => runtime.edit!({ path: "big.txt", oldText: "h", newText: "H" }), /exceeds limit/);
		await assert.rejects(
			() => runtime.edit!({ path: "small.txt", oldText: "hey", newText: "hello" }),
			/exceeds limit/,
		);
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});

test("host-bash uses a minimal environment unless hostEnv is configured", async () => {
	const root = await temp();
	const previous = process.env.HEYPI_SECRET_TEST;
	process.env.HEYPI_SECRET_TEST = "hidden";
	try {
		const runtime = hostBash({ root });
		const hidden = await runtime.bash?.({ command: "printenv HEYPI_SECRET_TEST || true" });
		assert.equal(hidden?.out, "");

		const configured = hostBash({ root, env: { HEYPI_SECRET_TEST: "visible" } });
		const visible = await configured.bash?.({ command: "printenv HEYPI_SECRET_TEST" });
		assert.equal(visible?.out, "visible\n");
	} finally {
		if (previous === undefined) delete process.env.HEYPI_SECRET_TEST;
		else process.env.HEYPI_SECRET_TEST = previous;
		await rm(root, { recursive: true, force: true });
	}
});

test("runtime tools include only implemented capabilities", () => {
	const runtime: Runtime = {
		name: "just-bash",
		root: "/tmp/unused",
		capabilities: { read: true, bash: true },
		read: async () => ({ path: "x", text: "ok" }),
		write: async () => ({ path: "x", bytes: 2 }),
		bash: async () => ({ code: 0, out: "ok", err: "", ms: 1 }),
	};
	const out = tools({ runtime, callRunner: fakeCallRunner(), channel: "c", actor: "u" });
	assert.deepEqual(
		out.map((tool) => tool.name),
		["bash", "read"],
	);
});

test("history tool searches current thread messages", async () => {
	const out = tools({
		runtime: { name: "just-bash", root: "/tmp/unused", capabilities: {} },
		callRunner: fakeCallRunner(),
		messages: new FakeMessages([
			{ id: "m1", role: "user", actor: "U1", text: "deploy failed in staging", createdAt: 1000 },
			{ id: "m2", role: "assistant", actor: "heypi", text: "staging error was fixed", createdAt: 2000 },
		]),
		channel: "c",
		actor: "u",
		context: { thread: "thread-1" },
	});

	assert.deepEqual(
		out.map((tool) => tool.name),
		["history"],
	);
	const result = await out[0].execute(
		"tool-call-1",
		{ query: "staging", limit: 1 },
		undefined,
		undefined,
		undefined as never,
	);
	const text = result.content?.[0]?.type === "text" ? result.content[0].text : "";
	assert.match(text, /staging error was fixed/);
	assert.doesNotMatch(text, /deploy failed/);
});

test("confirmed raw Pi tools fail closed without heypi replay runner", async () => {
	const warnings: Record<string, unknown>[] = [];
	const rawConfirmed: ToolDefinition & { confirm: Confirm } = {
		name: "raw_confirmed",
		label: "Raw Confirmed",
		description: "Raw confirmed tool",
		parameters: { type: "object", properties: {} },
		confirm: { reason: "needs approval" },
		execute: async () => ({ content: [{ type: "text", text: "unsafe" }], details: undefined }),
	};
	const out = tools({
		runtime: {
			name: "just-bash",
			root: "/tmp/unused",
			capabilities: {},
		},
		callRunner: fakeCallRunner(),
		channel: "c",
		actor: "u",
		logger: fakeLogger(warnings),
		custom: [rawConfirmed],
	});

	const result = await out[0].execute("call-1", {}, undefined, undefined, undefined as never);
	assert.match(result.content?.[0]?.type === "text" ? result.content[0].text : "", /requires confirmation/);
	assert.deepEqual(warnings, [
		{ event: "tool.confirm_rejected", tool: "raw_confirmed", reason: "missing heypi replay runner" },
	]);
});

test("confirmed heypi tools terminate the Pi turn while waiting for approval", async () => {
	const out = tools({
		runtime: {
			name: "just-bash",
			root: "/tmp/unused",
			capabilities: {},
		},
		callRunner: {
			bash: async () => ({ text: "ok" }),
			tool: async () => ({
				text: "approval=approval-1",
				approval: {
					id: "approval-1",
					callId: "call-1",
					command: "delete_ticket",
					runtime: "tool",
					reason: "delete",
					allowed: [],
				},
			}),
		},
		channel: "c",
		actor: "u",
		custom: [
			tool({
				name: "delete_ticket",
				description: "Delete a ticket",
				parameters: { type: "object", properties: {} },
				confirm: { reason: "delete" },
				execute: async () => "deleted",
			}),
		],
	});

	const result = await out[0].execute("tool-call-1", {}, undefined, undefined, undefined as never);
	assert.equal(result.terminate, true);
	assert.match(result.content?.[0]?.type === "text" ? result.content[0].text : "", /approval-1/);
});

test("custom tools add new names and override runtime tools", () => {
	const runtime: Runtime = {
		name: "just-bash",
		root: "/tmp/unused",
		capabilities: { bash: true },
		bash: async () => ({ code: 0, out: "base", err: "", ms: 1 }),
	};
	const warnings: Record<string, unknown>[] = [];
	const out = tools({
		runtime,
		callRunner: fakeCallRunner(),
		channel: "c",
		actor: "u",
		logger: fakeLogger(warnings),
		custom: [
			{
				name: "lookup",
				label: "Lookup",
				description: "Lookup test tool",
				parameters: { type: "object", properties: {} },
				execute: async () => ({ content: [{ type: "text", text: "lookup" }], details: undefined }),
			},
			{
				name: "bash",
				label: "Custom Bash",
				description: "Override bash",
				parameters: { type: "object", properties: {} },
				execute: async () => ({ content: [{ type: "text", text: "custom" }], details: undefined }),
			},
		],
	});
	assert.deepEqual(
		out.map((tool) => tool.name),
		["bash", "lookup"],
	);
	assert.equal(out.find((tool) => tool.name === "bash")?.label, "Custom Bash");
	assert.deepEqual(warnings, [{ event: "tool.override", tool: "bash" }]);
});

function fakeCallRunner() {
	return {
		bash: async () => ({ text: "ok" }),
		tool: async () => ({ text: "ok" }),
	};
}

function fakeLogger(warnings: Record<string, unknown>[]): Logger {
	return {
		debug: () => undefined,
		info: () => undefined,
		warn: (event, input = {}) => warnings.push({ event, ...input }),
		error: () => undefined,
	};
}

class FakeMessages implements Messages {
	constructor(private readonly rows: HistoryMessage[]) {}

	async create(): Promise<Message> {
		throw new Error("not implemented");
	}

	async createOnce(): Promise<{ row: Message; inserted: boolean }> {
		throw new Error("not implemented");
	}

	async listForThread(): Promise<Message[]> {
		throw new Error("not implemented");
	}

	async search(input: {
		threadId: string;
		query?: string;
		limit?: number;
		before?: number;
		includeTools?: boolean;
	}): Promise<HistoryMessage[]> {
		const query = input.query?.toLowerCase();
		return this.rows
			.filter((row) => !input.before || row.createdAt < input.before)
			.filter((row) => input.includeTools || (row.role !== "tool" && row.role !== "toolResult"))
			.filter((row) => !query || `${row.role}\n${row.actor ?? ""}\n${row.text}`.toLowerCase().includes(query))
			.slice(-(input.limit ?? 20));
	}

	async getToolResult(): Promise<Message | undefined> {
		throw new Error("not implemented");
	}

	async update(): Promise<void> {
		throw new Error("not implemented");
	}
}
