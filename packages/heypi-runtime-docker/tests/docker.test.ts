import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { BashResult, RuntimeEvent } from "@hunvreus/heypi/runtime";
import { type DockerCommandRunner, dockerRuntime } from "../src/index.js";

test("dockerRuntime keeps one warm container per scope and routes bash through docker exec", async () => {
	const calls: Array<{ command: string; args: string[] }> = [];
	const runner: DockerCommandRunner = async (command, args) => {
		calls.push({ command, args });
		if (args[0] === "inspect") return { code: 1, out: "", err: "missing", ms: 1 };
		if (args[0] === "run") return { code: 0, out: "container\n", err: "", ms: 1 };
		if (args[0] === "exec") return { code: 0, out: "ok\n", err: "", ms: 1 };
		if (args[0] === "rm") return { code: 0, out: "", err: "", ms: 1 };
		throw new Error(`unexpected docker command: ${args.join(" ")}`);
	};
	const provider = dockerRuntime({ runner, image: "test-image", network: "none", idleMs: false });
	const runtime = provider.get({ level: "channel", key: "channel/a", path: "channel/a", root: "/tmp/heypi-a" });

	const result = await runtime.bash?.({ command: "echo ok" });

	assert.equal(result?.out, "ok\n");
	assert.deepEqual(
		calls.map((call) => call.args[0]),
		["inspect", "rm", "run", "exec"],
	);
	const container = calls[2].args[3];
	assert.match(container, /^heypi-[a-f0-9]{16}$/);
	assert.deepEqual(calls[2].args.slice(0, 10), [
		"run",
		"-d",
		"--name",
		container,
		"--workdir",
		"/workspace",
		"-v",
		"/tmp/heypi-a:/workspace:rw",
		"--network",
		"none",
	]);
	assert.ok(calls[2].args.includes("--label"));
	assert.ok(calls[2].args.includes("heypi.runtime=docker"));
	assert.ok(calls[2].args.includes("heypi.scope.path=channel/a"));
	assert.deepEqual(calls[2].args.slice(-3), ["test-image", "sleep", "infinity"]);
	assert.deepEqual(calls[3].args, ["exec", "-i", container, "bash", "-lc", "echo ok"]);

	await provider.close?.();
	assert.equal(calls.at(-1)?.args[0], "rm");
});

test("dockerRuntime exposes file and search tools inside the scoped container workspace", async () => {
	const root = await mkdtemp(join(tmpdir(), "heypi-docker-runtime-"));
	const provider = dockerRuntime({ runner: localDockerRunner(root), idleMs: false });
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
});

test("dockerRuntime reports status and can restart a known scope", async () => {
	const calls: Array<{ command: string; args: string[] }> = [];
	let running = false;
	const runner: DockerCommandRunner = async (command, args) => {
		calls.push({ command, args });
		if (args[0] === "inspect") return { code: running ? 0 : 1, out: running ? "true\n" : "", err: "", ms: 1 };
		if (args[0] === "run") {
			running = true;
			return { code: 0, out: "container\n", err: "", ms: 1 };
		}
		if (args[0] === "exec") return { code: 0, out: "ok\n", err: "", ms: 1 };
		if (args[0] === "rm") {
			running = false;
			return { code: 0, out: "", err: "", ms: 1 };
		}
		throw new Error(`unexpected docker command: ${args.join(" ")}`);
	};
	const provider = dockerRuntime({ runner, image: "test-image", idleMs: false });
	const scope = { level: "channel", key: "channel/a", path: "channel/a", root: "/tmp/heypi-a" };
	const runtime = provider.get(scope);

	await runtime.bash?.({ command: "echo ok" });
	assert.equal((await provider.status?.())?.[0]?.state, "running");

	await provider.restart?.(scope);

	assert.equal((await provider.status?.(scope))?.[0]?.state, "running");
	assert.equal(calls.filter((call) => call.args[0] === "run").length, 2);
	await provider.stop?.(scope);
	assert.equal((await provider.status?.(scope))?.[0]?.state, "stopped");
});

test("dockerRuntime emits startup events only when a scoped container starts", async () => {
	let running = false;
	const runner: DockerCommandRunner = async (_command, args) => {
		if (args[0] === "inspect") return { code: running ? 0 : 1, out: running ? "true\n" : "", err: "", ms: 1 };
		if (args[0] === "run") {
			running = true;
			return { code: 0, out: "container\n", err: "", ms: 1 };
		}
		if (args[0] === "exec") return { code: 0, out: "ok\n", err: "", ms: 1 };
		if (args[0] === "rm") {
			running = false;
			return { code: 0, out: "", err: "", ms: 1 };
		}
		throw new Error(`unexpected docker command: ${args.join(" ")}`);
	};
	const provider = dockerRuntime({ runner, image: "test-image", idleMs: false });
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

test("dockerRuntime recreates a cached container that is no longer running", async () => {
	const calls: string[] = [];
	let running = false;
	let inspectCount = 0;
	const runner: DockerCommandRunner = async (_command, args) => {
		calls.push(args[0]);
		if (args[0] === "inspect") {
			inspectCount++;
			const alive = running && inspectCount !== 2;
			return { code: alive ? 0 : 1, out: alive ? "true\n" : "", err: "", ms: 1 };
		}
		if (args[0] === "run") {
			running = true;
			return { code: 0, out: "container\n", err: "", ms: 1 };
		}
		if (args[0] === "exec") return { code: 0, out: "ok\n", err: "", ms: 1 };
		if (args[0] === "rm") {
			running = false;
			return { code: 0, out: "", err: "", ms: 1 };
		}
		throw new Error(`unexpected docker command: ${args.join(" ")}`);
	};
	const provider = dockerRuntime({ runner, image: "test-image", idleMs: false });
	const runtime = provider.get({ level: "channel", key: "channel/a", path: "channel/a", root: "/tmp/heypi-a" });

	await runtime.bash?.({ command: "echo one" });
	await runtime.bash?.({ command: "echo two" });

	assert.equal(calls.filter((call) => call === "run").length, 2);
	await provider.close?.();
});

test("dockerRuntime does not idle-stop a container during an active command", async () => {
	const calls: string[] = [];
	let running = false;
	const runner: DockerCommandRunner = async (_command, args) => {
		calls.push(args[0]);
		if (args[0] === "inspect") return { code: running ? 0 : 1, out: running ? "true\n" : "", err: "", ms: 1 };
		if (args[0] === "run") {
			running = true;
			return { code: 0, out: "container\n", err: "", ms: 1 };
		}
		if (args[0] === "exec") {
			await sleep(25);
			assert.equal(calls.filter((call) => call === "rm").length, 1);
			return { code: 0, out: "ok\n", err: "", ms: 25 };
		}
		if (args[0] === "rm") {
			running = false;
			return { code: 0, out: "", err: "", ms: 1 };
		}
		throw new Error(`unexpected docker command: ${args.join(" ")}`);
	};
	const provider = dockerRuntime({ runner, image: "test-image", idleMs: 5 });
	const runtime = provider.get({ level: "channel", key: "channel/a", path: "channel/a", root: "/tmp/heypi-a" });

	await runtime.bash?.({ command: "sleep" });
	await sleep(20);

	assert.equal(calls.filter((call) => call === "rm").length, 2);
});

function localDockerRunner(root: string): DockerCommandRunner {
	let running = false;
	return async (_command, args, options) => {
		if (args[0] === "inspect") return { code: running ? 0 : 1, out: running ? "true\n" : "", err: "missing", ms: 1 };
		if (args[0] === "run") {
			running = true;
			return { code: 0, out: "container\n", err: "", ms: 1 };
		}
		if (args[0] === "rm") {
			running = false;
			return { code: 0, out: "", err: "", ms: 1 };
		}
		if (args[0] !== "exec") throw new Error(`unexpected docker command: ${args.join(" ")}`);
		return await runLocal(args.slice(3), root, options.input);
	};
}

async function runLocal(args: string[], cwd: string, input?: string | Buffer): Promise<BashResult> {
	const start = Date.now();
	return await new Promise((resolve) => {
		const proc = spawn(args[0], args.slice(1), { cwd, stdio: ["pipe", "pipe", "pipe"] });
		let out = "";
		let err = "";
		proc.stdout.on("data", (chunk: Buffer) => {
			out += chunk.toString("utf8");
		});
		proc.stderr.on("data", (chunk: Buffer) => {
			err += chunk.toString("utf8");
		});
		proc.stdin.end(input);
		proc.on("error", (error) => resolve({ code: 127, out, err: `${err}${error.message}`, ms: Date.now() - start }));
		proc.on("close", (code) => resolve({ code: code ?? 1, out, err, ms: Date.now() - start }));
	});
}

async function sleep(ms: number): Promise<void> {
	await new Promise((resolve) => setTimeout(resolve, ms));
}
