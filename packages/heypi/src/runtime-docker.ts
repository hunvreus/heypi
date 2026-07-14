import { spawn } from "node:child_process";
import { posix } from "node:path";
import {
	type BashOperations,
	createBashToolDefinition,
	createEditToolDefinition,
	createFindToolDefinition,
	createGrepToolDefinition,
	createLsToolDefinition,
	createReadToolDefinition,
	createWriteToolDefinition,
	type ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import { assertGuestPath, GUEST_SHARED, GUEST_WORKSPACE, guestPath, type RuntimeRoots } from "./runtime-path.js";
import { globPattern, guardPathInput, run, runBuffer } from "./runtime-util.js";
import type { RuntimeConfig } from "./types.js";

async function dockerContainer(
	runtime: RuntimeConfig,
	roots: RuntimeRoots,
): Promise<{ id: string; cleanup(): Promise<void> }> {
	const image = "image" in runtime && typeof runtime.image === "string" ? runtime.image : "node:22-bookworm";
	const args = [
		"run",
		"--rm",
		"-d",
		"-w",
		GUEST_WORKSPACE,
		"-v",
		`${roots.workspace}:${GUEST_WORKSPACE}`,
		...(roots.shared ? ["-v", `${roots.shared}:${GUEST_SHARED}`] : []),
		...Object.entries(runtime.env ?? {}).flatMap(([key, value]) => ["-e", `${key}=${value}`]),
		image,
		"sleep",
		"infinity",
	];
	const id = await run("docker", args);
	return {
		id,
		async cleanup() {
			await run("docker", ["rm", "-f", id]).catch(() => undefined);
		},
	};
}

function dockerPath(roots: RuntimeRoots, inputPath: string): string {
	return guestPath(roots, inputPath);
}

function dockerFindCwd(roots: RuntimeRoots, cwd: string | undefined): string {
	if (!cwd || cwd === ".") return GUEST_WORKSPACE;
	return assertGuestPath(dockerPath(roots, cwd));
}

function dockerExec(containerId: string, args: string[], options: { input?: string | Buffer } = {}): Promise<Buffer> {
	return runBuffer("docker", ["exec", ...(options.input === undefined ? [] : ["-i"]), containerId, ...args], options);
}

function dockerFileTools(containerId: string, roots: RuntimeRoots): ToolDefinition<any, any, any>[] {
	const readOps = {
		readFile: (path: string) => dockerExec(containerId, ["cat", assertGuestPath(dockerPath(roots, path))]),
		access: async (path: string) => {
			await dockerExec(containerId, ["test", "-e", assertGuestPath(dockerPath(roots, path))]);
		},
	};
	const writeOps = {
		writeFile: async (path: string, content: string) => {
			const resolved = assertGuestPath(dockerPath(roots, path));
			await dockerExec(containerId, ["sh", "-lc", 'cat > "$1"', "sh", resolved], { input: content });
		},
		mkdir: async (path: string) => {
			await dockerExec(containerId, ["mkdir", "-p", assertGuestPath(dockerPath(roots, path))]);
		},
	};
	const grepOps = {
		isDirectory: async (path: string) => {
			const resolved = assertGuestPath(dockerPath(roots, path));
			await dockerExec(containerId, ["test", "-e", resolved]);
			return dockerExec(containerId, ["test", "-d", resolved])
				.then(() => true)
				.catch(() => false);
		},
		readFile: async (path: string) => (await readOps.readFile(path)).toString("utf8"),
	};
	const findOps = {
		exists: async (path: string) => {
			try {
				await readOps.access(path);
				return true;
			} catch {
				return false;
			}
		},
		glob: async (pattern: string, cwd: string, options: { ignore: string[]; limit: number }) => {
			const root = dockerFindCwd(roots, cwd);
			const matcher = globPattern(pattern.includes("/") ? pattern : `**/${pattern}`);
			const output = await dockerExec(containerId, ["find", root, "-type", "f"]);
			return output
				.toString("utf8")
				.split("\n")
				.map((line) => line.trim())
				.filter(Boolean)
				.filter(
					(line) =>
						!options.ignore.some((ignore) => line.includes(ignore.replace(/[*]/g, "").replace(/\/+/g, "/"))),
				)
				.filter((line) => matcher.test(posix.relative(root, line)))
				.slice(0, options.limit);
		},
	};
	const lsOps = {
		exists: findOps.exists,
		stat: async (path: string) => {
			const isDirectory = await dockerExec(containerId, ["test", "-d", assertGuestPath(dockerPath(roots, path))])
				.then(() => true)
				.catch(() => false);
			return { isDirectory: () => isDirectory };
		},
		readdir: async (path: string) => {
			const output = await dockerExec(containerId, [
				"find",
				assertGuestPath(dockerPath(roots, path)),
				"-maxdepth",
				"1",
				"-mindepth",
				"1",
			]);
			return output
				.toString("utf8")
				.split("\n")
				.map((line) => line.trim())
				.filter(Boolean)
				.map((line) => posix.basename(line));
		},
	};
	return [
		createReadToolDefinition(GUEST_WORKSPACE, { operations: readOps }),
		createEditToolDefinition(GUEST_WORKSPACE, { operations: { ...readOps, ...writeOps } }),
		createWriteToolDefinition(GUEST_WORKSPACE, { operations: writeOps }),
		guardPathInput(
			createGrepToolDefinition(GUEST_WORKSPACE, { operations: grepOps }),
			(path) => {
				assertGuestPath(dockerPath(roots, path));
			},
			["path"],
		),
		createFindToolDefinition(GUEST_WORKSPACE, { operations: findOps }),
		guardPathInput(
			createLsToolDefinition(GUEST_WORKSPACE, { operations: lsOps }),
			(path) => {
				assertGuestPath(dockerPath(roots, path));
			},
			["path"],
		),
	];
}

function dockerBashOperations(
	containerId: string,
	roots: RuntimeRoots,
	env: Record<string, string> | undefined,
): BashOperations {
	return {
		exec(command, cwd, options) {
			return new Promise((resolvePromise, reject) => {
				const args = [
					"exec",
					"-w",
					guestPath(roots, cwd),
					...Object.entries(env ?? {}).flatMap(([key, value]) => ["-e", `${key}=${value}`]),
					containerId,
					"sh",
					"-lc",
					command,
				];
				const child = spawn("docker", args, { stdio: ["ignore", "pipe", "pipe"] });
				const abort = () => child.kill("SIGTERM");
				let timeout: NodeJS.Timeout | undefined;
				options.signal?.addEventListener("abort", abort, { once: true });
				if (options.timeout && options.timeout > 0) timeout = setTimeout(abort, options.timeout * 1000);
				child.stdout.on("data", options.onData);
				child.stderr.on("data", options.onData);
				child.on("error", reject);
				child.on("close", (code) => {
					if (timeout) clearTimeout(timeout);
					options.signal?.removeEventListener("abort", abort);
					resolvePromise({ exitCode: code });
				});
			});
		},
	};
}

export async function createDockerRuntimeTools(
	runtime: RuntimeConfig,
	roots: RuntimeRoots,
): Promise<{ tools: ToolDefinition<any, any, any>[]; cleanup(): Promise<void> }> {
	const container = await dockerContainer(runtime, roots);
	return {
		tools: [
			...dockerFileTools(container.id, roots),
			createBashToolDefinition(GUEST_WORKSPACE, {
				operations: dockerBashOperations(container.id, roots, runtime.env),
			}),
		],
		cleanup: container.cleanup,
	};
}
