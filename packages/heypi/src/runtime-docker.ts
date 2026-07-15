import { spawn } from "node:child_process";
import { posix } from "node:path";
import type { BashOperations, FindOperations } from "@earendil-works/pi-coding-agent";
import { assertGuestPath, GUEST_SHARED, GUEST_WORKSPACE, guestPath, type RuntimeRoots } from "./runtime-path.js";
import { createRuntimeToolDefinitions, type RuntimeFileSystem } from "./runtime-provider.js";
import { globPattern, run, runBuffer } from "./runtime-util.js";
import type { RuntimeConfig, RuntimeInstance } from "./types.js";

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

function dockerExec(container: string, args: string[], input?: string | Buffer): Promise<Buffer> {
	return runBuffer("docker", ["exec", ...(input === undefined ? [] : ["-i"]), container, ...args], { input });
}

function dockerFileSystem(container: string, roots: RuntimeRoots): RuntimeFileSystem {
	const resolve = (path: string) => assertGuestPath(guestPath(roots, path));
	return {
		access: async (path) => {
			await dockerExec(container, ["test", "-e", resolve(path)]);
		},
		mkdir: async (path) => {
			await dockerExec(container, ["mkdir", "-p", resolve(path)]);
		},
		readFile: (path) => dockerExec(container, ["cat", resolve(path)]),
		readdir: async (path) => {
			const output = await dockerExec(container, ["find", resolve(path), "-maxdepth", "1", "-mindepth", "1"]);
			return output
				.toString("utf8")
				.split("\n")
				.filter(Boolean)
				.map((line) => posix.basename(line));
		},
		stat: async (path) => {
			const directory = await dockerExec(container, ["test", "-d", resolve(path)])
				.then(() => true)
				.catch(() => false);
			return { isDirectory: () => directory };
		},
		writeFile: async (path, content) => {
			await dockerExec(
				container,
				["sh", "-lc", 'cat > "$1"', "sh", resolve(path)],
				typeof content === "string" ? content : Buffer.from(content),
			);
		},
	};
}

function dockerFindOperations(container: string, roots: RuntimeRoots): FindOperations {
	return {
		exists: async (path) => {
			const resolved = assertGuestPath(guestPath(roots, path));
			try {
				await dockerExec(container, ["test", "-e", resolved]);
				return true;
			} catch {
				return false;
			}
		},
		glob: async (pattern, cwd, options) => {
			const root = assertGuestPath(guestPath(roots, cwd));
			const matcher = globPattern(pattern.includes("/") ? pattern : `**/${pattern}`);
			const output = await dockerExec(container, ["find", root, "-type", "f"]);
			return output
				.toString("utf8")
				.split("\n")
				.filter(Boolean)
				.filter(
					(line) =>
						!options.ignore.some((ignore) => line.includes(ignore.replace(/[*]/g, "").replace(/\/+/g, "/"))),
				)
				.filter((line) => matcher.test(posix.relative(root, line)))
				.slice(0, options.limit);
		},
	};
}

function dockerBashOperations(container: string, roots: RuntimeRoots, env?: Record<string, string>): BashOperations {
	return {
		exec(command, cwd, options) {
			return new Promise((resolve, reject) => {
				const args = [
					"exec",
					"-w",
					guestPath(roots, cwd),
					...Object.entries(env ?? {}).flatMap(([key, value]) => ["-e", `${key}=${value}`]),
					container,
					"sh",
					"-lc",
					command,
				];
				const child = spawn("docker", args, { stdio: ["ignore", "pipe", "pipe"] });
				const abort = () => child.kill("SIGTERM");
				const timeout = options.timeout ? setTimeout(abort, options.timeout * 1000) : undefined;
				options.signal?.addEventListener("abort", abort, { once: true });
				child.stdout.on("data", options.onData);
				child.stderr.on("data", options.onData);
				child.on("error", reject);
				child.on("close", (code) => {
					if (timeout) clearTimeout(timeout);
					options.signal?.removeEventListener("abort", abort);
					resolve({ exitCode: code });
				});
			});
		},
	};
}

export async function createDockerRuntimeTools(runtime: RuntimeConfig, roots: RuntimeRoots): Promise<RuntimeInstance> {
	const container = await dockerContainer(runtime, roots);
	return {
		tools: createRuntimeToolDefinitions({
			fs: dockerFileSystem(container.id, roots),
			bash: dockerBashOperations(container.id, roots, runtime.env),
			find: dockerFindOperations(container.id, roots),
			roots,
		}),
		cleanup: container.cleanup,
	};
}
