import assert from "node:assert/strict";
import { mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import type { Logger } from "../src/core/log.js";
import type { Confirm, ReplyAttachment } from "../src/core/types.js";
import { hostBash } from "../src/runtime/host-bash.js";
import { justBash } from "../src/runtime/just-bash.js";
import { executeProcess } from "../src/runtime/shell.js";
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

test("host-bash file tools reject symlink escapes", async () => {
	const root = await temp();
	const outside = await temp();
	try {
		await writeFile(join(outside, "secret.txt"), "secret", "utf8");
		await symlink(join(outside, "secret.txt"), join(root, "link.txt"));
		const runtime = hostBash({ root });

		await assert.rejects(() => runtime.read!({ path: "link.txt" }), /escapes runtime root/);
		await assert.rejects(
			() => runtime.edit!({ path: "link.txt", oldText: "secret", newText: "x" }),
			/escapes runtime root/,
		);
		await assert.rejects(() => runtime.write!({ path: "link.txt", content: "x" }), /escapes runtime root/);
	} finally {
		await rm(root, { recursive: true, force: true });
		await rm(outside, { recursive: true, force: true });
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

test("host-bash does not source host shell startup files", async () => {
	const root = await temp();
	const home = await temp();
	try {
		await writeFile(join(home, ".bash_profile"), "export HEYPI_RC_FILE_LOADED=yes\n", "utf8");
		const runtime = hostBash({ root, env: { HOME: home } });
		const result = await runtime.bash?.({ command: "printenv HEYPI_RC_FILE_LOADED || true" });

		assert.equal(result?.code, 0);
		assert.equal(result?.out, "");
	} finally {
		await rm(root, { recursive: true, force: true });
		await rm(home, { recursive: true, force: true });
	}
});

test("process execution kills commands that exceed the stream output cap", async () => {
	const root = await temp();
	try {
		const result = await executeProcess(process.execPath, ["-e", "process.stdout.write('x'.repeat(300000));"], {
			cwd: root,
			timeoutMs: 10_000,
			env: { PATH: process.env.PATH ?? "" },
		});

		assert.equal(result.code, 125);
		assert.ok(result.out.length <= 64 * 1024 + "...[truncated]\n".length);
		assert.match(result.out, /truncated/);
		assert.match(result.err, /output exceeded/);
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});

test("runtime tools include only implemented runtime methods", () => {
	const runtime: Runtime = {
		name: "just-bash",
		root: "/tmp/unused",
		read: async () => ({ path: "x", text: "ok" }),
		write: async () => ({ path: "x", bytes: 2 }),
		bash: async () => ({ code: 0, out: "ok", err: "", ms: 1 }),
	};
	const out = tools({ runtime, callRunner: fakeCallRunner(), channel: "c", actor: "u" });
	assert.deepEqual(
		out.map((tool) => tool.name),
		["bash", "read", "write"],
	);
});

test("history tool searches current thread messages", async () => {
	const out = tools({
		runtime: { name: "just-bash", root: "/tmp/unused" },
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

test("attach tool records scoped runtime files for the final reply", async () => {
	const attachments: ReplyAttachment[] = [];
	const out = tools({
		runtime: { name: "just-bash", root: "/tmp/unused" },
		callRunner: fakeCallRunner(),
		channel: "c",
		actor: "u",
		context: { runtimeScope: "channel/a/slack/T/C" },
		attachments,
	});
	const attach = out.find((tool) => tool.name === "attach");
	assert.ok(attach);

	const result = await attach.execute(
		"tool-call-1",
		{ path: "reports/status.txt", name: "status.txt", mimeType: "text/plain" },
		undefined,
		undefined,
		undefined as never,
	);

	assert.equal(result.content?.[0]?.type === "text" ? result.content[0].text : "", "attached status.txt");
	assert.deepEqual(attachments, [
		{
			path: "scopes/channel/a/slack/T/C/reports/status.txt",
			scope: "channel/a/slack/T/C",
			name: "status.txt",
			mimeType: "text/plain",
		},
	]);
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
	assert.deepEqual(result.details, {
		state: "pending_approval",
		approval: {
			id: "approval-1",
			callId: "call-1",
			command: "delete_ticket",
			runtime: "tool",
			reason: "delete",
			allowed: [],
		},
	});
});

test("custom tools add new names and override runtime tools", () => {
	const runtime: Runtime = {
		name: "just-bash",
		root: "/tmp/unused",
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

test("heypi custom tools receive the selected runtime context", async () => {
	let seenScope: string | undefined;
	const runtime: Runtime = {
		name: "test-runtime",
		root: "/tmp/unused",
		bash: async ({ command }) => ({ code: 0, out: `ran:${command}`, err: "", ms: 1 }),
	};
	const out = tools({
		runtime,
		callRunner: fakeCallRunner(),
		channel: "c",
		actor: "u",
		context: { runtimeScope: "scope/path" },
		core: [],
		custom: [
			tool({
				name: "inspect",
				description: "Inspect through runtime",
				parameters: { type: "object", properties: {} },
				execute: async (_params, ctx) => {
					seenScope = ctx.runtimeScope;
					const result = await ctx.runtime.bash?.({ command: "echo ok", signal: ctx.signal });
					return result?.out ?? "missing runtime";
				},
			}),
		],
	});

	const result = await out[0].execute("tool-call-1", {}, undefined, undefined, undefined as never);
	assert.equal(result.content?.[0]?.type === "text" ? result.content[0].text : "", "ran:echo ok");
	assert.equal(seenScope, "scope/path");
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

	async get(): Promise<Message | undefined> {
		throw new Error("not implemented");
	}

	async getByProviderEvent(): Promise<Message | undefined> {
		throw new Error("not implemented");
	}

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

	async update(): Promise<void> {
		throw new Error("not implemented");
	}
}
