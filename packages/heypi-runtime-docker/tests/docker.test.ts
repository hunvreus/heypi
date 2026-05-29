import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { BashResult } from "@hunvreus/heypi/runtime";
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
	assert.deepEqual(calls[2].args.slice(0, 12), [
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
		"test-image",
		"sleep",
	]);
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

function localDockerRunner(root: string): DockerCommandRunner {
	return async (_command, args, options) => {
		if (args[0] === "inspect") return { code: 1, out: "", err: "missing", ms: 1 };
		if (args[0] === "run") return { code: 0, out: "container\n", err: "", ms: 1 };
		if (args[0] === "rm") return { code: 0, out: "", err: "", ms: 1 };
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
