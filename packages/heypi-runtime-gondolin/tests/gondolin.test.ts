import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { ExecOptions, ExecResult, VMOptions } from "@earendil-works/gondolin";
import type { BashResult, RuntimeEvent } from "@hunvreus/heypi/runtime";
import { type GondolinVm, type GondolinVmFactory, gondolinRuntime } from "../src/index.js";

test("gondolinRuntime keeps one VM per scope and routes bash through vm.exec", async () => {
	const created: VMOptions[] = [];
	const execs: Array<{ command: string | string[]; options?: ExecOptions }> = [];
	let closed = 0;
	const factory: GondolinVmFactory = async (options) => {
		created.push(options);
		return {
			id: "vm-1",
			exec(command, execOptions) {
				execs.push({ command, options: execOptions });
				return Promise.resolve(new FakeExecResult() as ExecResult);
			},
			async close() {
				closed++;
			},
		} satisfies GondolinVm;
	};
	const provider = gondolinRuntime({
		factory,
		env: { FOO: "bar" },
		sessionLabel: (scope) => `test ${scope.path}`,
		idleMs: false,
	});
	const scope = { level: "channel", key: "channel/a", path: "channel/a", root: "/tmp/heypi-a" };
	const runtime = provider.get(scope);

	const result = await runtime.bash?.({ command: "echo ok" });

	assert.equal(result?.out, "ok\n");
	assert.equal(created.length, 1);
	assert.equal(created[0].sessionLabel, "test channel/a");
	assert.deepEqual(created[0].env, { FOO: "bar" });
	assert.deepEqual(
		execs.map((exec) => exec.command),
		["echo ok"],
	);
	assert.equal(execs[0].options?.cwd, "/workspace");

	await provider.close?.();
	assert.equal(closed, 1);
});

test("gondolinRuntime exposes file and search tools inside the scoped VM workspace", async () => {
	const root = await mkdtemp(join(tmpdir(), "heypi-gondolin-runtime-"));
	let closed = 0;
	const provider = gondolinRuntime({
		factory: async () =>
			({
				exec(command, options) {
					return runLocal(command, options, root).then((result) => new FakeExecResult(result) as ExecResult);
				},
				async close() {
					closed++;
				},
			}) satisfies GondolinVm,
		idleMs: false,
	});
	const runtime = provider.get({ level: "channel", key: "channel/a", path: "channel/a", root });
	try {
		await runtime.write?.({ path: "notes/a.txt", content: "alpha\nbeta\nalpha" });

		assert.deepEqual(await runtime.read?.({ path: "notes/a.txt", offset: 2, limit: 1 }), {
			path: "notes/a.txt",
			text: "beta",
			lines: 3,
		});
		assert.deepEqual(await runtime.ls?.({ path: "notes" }), {
			entries: [{ name: "a.txt", path: "notes/a.txt", type: "file", size: 16 }],
		});
		assert.deepEqual(await runtime.find?.({ pattern: "**/*.txt" }), { paths: ["notes/a.txt"] });
		assert.deepEqual(await runtime.grep?.({ query: "alpha" }), {
			hits: [
				{ path: "notes/a.txt", line: 1, text: "alpha" },
				{ path: "notes/a.txt", line: 3, text: "alpha" },
			],
		});

		assert.deepEqual(
			await runtime.edit?.({ path: "notes/a.txt", oldText: "alpha", newText: "omega", replaceAll: true }),
			{
				path: "notes/a.txt",
				replacements: 2,
			},
		);
		assert.equal((await runtime.read?.({ path: "notes/a.txt" }))?.text, "omega\nbeta\nomega");
		await assert.rejects(() => runtime.read?.({ path: "../escape" }) ?? Promise.resolve(), /escapes runtime root/);
	} finally {
		await provider.close?.();
		await rm(root, { recursive: true, force: true });
	}
	assert.equal(closed, 1);
});

test("gondolinRuntime reports status and can restart a known scope", async () => {
	let created = 0;
	let closed = 0;
	const provider = gondolinRuntime({
		factory: async () => {
			created++;
			return {
				id: `vm-${created}`,
				exec() {
					return Promise.resolve(new FakeExecResult() as ExecResult);
				},
				async close() {
					closed++;
				},
			} satisfies GondolinVm;
		},
		idleMs: false,
	});
	const scope = { level: "channel", key: "channel/a", path: "channel/a", root: "/tmp/heypi-a" };
	const runtime = provider.get(scope);

	await runtime.bash?.({ command: "echo ok" });
	assert.equal((await provider.status?.())?.[0]?.state, "running");
	assert.equal((await provider.status?.())?.[0]?.id, "vm-1");

	await provider.restart?.(scope);

	assert.equal((await provider.status?.(scope))?.[0]?.id, "vm-2");
	assert.equal(created, 2);
	assert.equal(closed, 1);
	await provider.stop?.(scope);
	assert.equal((await provider.status?.(scope))?.[0]?.state, "stopped");
});

test("gondolinRuntime emits startup events only when a scoped VM starts", async () => {
	let created = 0;
	const provider = gondolinRuntime({
		factory: async () => {
			created++;
			return {
				id: `vm-${created}`,
				exec() {
					return Promise.resolve(new FakeExecResult() as ExecResult);
				},
				async close() {
					return undefined;
				},
			} satisfies GondolinVm;
		},
		idleMs: false,
	});
	const runtime = provider.get({ level: "channel", key: "channel/a", path: "channel/a", root: "/tmp/heypi-a" });
	const events: RuntimeEvent[] = [];
	const runtimeEvents = (event: RuntimeEvent) => {
		events.push(event);
	};

	await runtime.bash?.({ command: "echo one", runtimeEvents });
	assert.deepEqual(
		events.map((event) => event.kind),
		["starting", "start"],
	);
	assert.equal(events[0].message, undefined);

	events.length = 0;
	await runtime.bash?.({ command: "echo two", runtimeEvents });
	assert.deepEqual(
		events.map((event) => event.kind),
		["reuse"],
	);

	await provider.close?.();
});

test("gondolinRuntime does not idle-stop a VM during an active command", async () => {
	let closed = 0;
	const provider = gondolinRuntime({
		factory: async () =>
			({
				id: "vm-1",
				async exec() {
					await sleep(25);
					assert.equal(closed, 0);
					return new FakeExecResult() as ExecResult;
				},
				async close() {
					closed++;
				},
			}) satisfies GondolinVm,
		idleMs: 5,
	});
	const runtime = provider.get({ level: "channel", key: "channel/a", path: "channel/a", root: "/tmp/heypi-a" });

	await runtime.bash?.({ command: "sleep" });
	await sleep(20);

	assert.equal(closed, 1);
});

async function sleep(ms: number): Promise<void> {
	await new Promise((resolve) => setTimeout(resolve, ms));
}

async function runLocal(
	command: string | string[],
	options: ExecOptions | undefined,
	cwd: string,
): Promise<BashResult> {
	const start = Date.now();
	return await new Promise((resolve) => {
		const executable = typeof command === "string" ? "sh" : command[0];
		const args = typeof command === "string" ? ["-c", command, "heypi", ...(options?.argv ?? [])] : command.slice(1);
		const proc = spawn(executable, args, { cwd, stdio: ["pipe", "pipe", "pipe"] });
		let out = "";
		let err = "";
		proc.stdout.on("data", (chunk: Buffer) => {
			out += chunk.toString("utf8");
		});
		proc.stderr.on("data", (chunk: Buffer) => {
			err += chunk.toString("utf8");
		});
		const stdin = typeof options?.stdin === "boolean" ? undefined : options?.stdin;
		proc.stdin.end(stdin);
		proc.on("error", (error) => resolve({ code: 127, out, err: `${err}${error.message}`, ms: Date.now() - start }));
		proc.on("close", (code) => resolve({ code: code ?? 1, out, err, ms: Date.now() - start }));
	});
}

class FakeExecResult {
	readonly id = 1;
	readonly signal = undefined;
	readonly exitCode: number;
	readonly stdout: string;
	readonly stderr: string;

	constructor(result: BashResult = { code: 0, out: "ok\n", err: "", ms: 1 }) {
		this.exitCode = result.code;
		this.stdout = result.out;
		this.stderr = result.err;
	}
}
