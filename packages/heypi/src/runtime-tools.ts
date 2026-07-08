import { spawn } from "node:child_process";
import { access, mkdir, readdir, readFile, stat, writeFile } from "node:fs/promises";
import { isAbsolute, posix, relative, resolve, sep } from "node:path";
import {
	type BashOperations,
	createBashToolDefinition,
	createEditToolDefinition,
	createFindToolDefinition,
	createGrepToolDefinition,
	createLocalBashOperations,
	createLsToolDefinition,
	createReadToolDefinition,
	createWriteToolDefinition,
	type ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import type { RuntimeConfig } from "./types.js";

const GUEST_WORKSPACE = "/workspace";

export type RuntimeTools = {
	tools: ToolDefinition<any, any, any>[];
	cleanup(): Promise<void>;
};

function inside(root: string, path: string): boolean {
	const rel = relative(root, path);
	return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

function assertInside(root: string, path: string): void {
	if (!inside(root, path)) throw new Error(`path escapes runtime workspace: ${path}`);
}

function assertGuestPath(path: string): string {
	const normalized = posix.normalize(path);
	if (normalized !== GUEST_WORKSPACE && !normalized.startsWith(`${GUEST_WORKSPACE}/`)) {
		throw new Error(`path escapes runtime workspace: ${path}`);
	}
	return normalized;
}

function guestPath(workspace: string, inputPath: string): string {
	if (inputPath === GUEST_WORKSPACE || inputPath.startsWith(`${GUEST_WORKSPACE}/`)) {
		return assertGuestPath(inputPath);
	}
	const resolved = isAbsolute(inputPath) ? resolve(inputPath) : resolve(workspace, inputPath);
	assertInside(workspace, resolved);
	const rel = relative(workspace, resolved).split(sep).join("/");
	return rel ? `${GUEST_WORKSPACE}/${rel}` : GUEST_WORKSPACE;
}

function guestCwd(workspace: string, cwd: string): string {
	return guestPath(workspace, cwd);
}

function asTools(tools: ToolDefinition<any, any, any>[]): ToolDefinition<any, any, any>[] {
	return tools;
}

function globPattern(pattern: string): RegExp {
	let source = "^";
	for (let index = 0; index < pattern.length; index++) {
		const char = pattern[index];
		const next = pattern[index + 1];
		const afterNext = pattern[index + 2];
		if (char === "*" && next === "*" && afterNext === "/") {
			source += "(?:.*/)?";
			index += 2;
		} else if (char === "*" && next === "*") {
			source += ".*";
			index++;
		} else if (char === "*") {
			source += "[^/]*";
		} else if (char === "?") {
			source += "[^/]";
		} else {
			source += char.replace(/[|\\{}()[\]^$+?.]/g, "\\$&");
		}
	}
	return new RegExp(`${source}$`);
}

async function findFiles(
	root: string,
	pattern: string,
	options: { ignore: string[]; limit: number },
): Promise<string[]> {
	const matcher = globPattern(pattern.includes("/") ? pattern : `**/${pattern}`);
	const results: string[] = [];
	const ignored = new Set(options.ignore.map((entry) => entry.replace(/^\*\*\//, "").replace(/\/\*\*$/, "")));

	async function visit(dir: string): Promise<void> {
		if (results.length >= options.limit) return;
		const entries = await readdir(dir, { withFileTypes: true });
		for (const entry of entries) {
			if (results.length >= options.limit) return;
			if (ignored.has(entry.name)) continue;
			const absolute = resolve(dir, entry.name);
			if (entry.isDirectory()) {
				await visit(absolute);
				continue;
			}
			const relativePath = relative(root, absolute).split(sep).join("/");
			if (matcher.test(relativePath)) results.push(absolute);
		}
	}

	await visit(root);
	return results;
}

function hostFileTools(workspace: string, env?: Record<string, string>): ToolDefinition<any, any, any>[] {
	const guard = (path: string) => {
		const resolved = isAbsolute(path) ? resolve(path) : resolve(workspace, path);
		assertInside(workspace, resolved);
		return resolved;
	};
	const readOps = {
		readFile: (path: string) => readFile(guard(path)),
		access: (path: string) => access(guard(path)),
	};
	const writeOps = {
		writeFile: (path: string, content: string) => writeFile(guard(path), content),
		mkdir: async (path: string) => {
			await mkdir(guard(path), { recursive: true });
		},
	};
	const editOps = {
		readFile: readOps.readFile,
		writeFile: writeOps.writeFile,
		access: readOps.access,
	};
	const grepOps = {
		isDirectory: async (path: string) => (await stat(guard(path))).isDirectory(),
		readFile: async (path: string) => readFile(guard(path), "utf8"),
	};
	const findOps = {
		exists: async (path: string) => {
			try {
				await access(guard(path));
				return true;
			} catch {
				return false;
			}
		},
		glob: async (pattern: string, cwd: string, options: { ignore: string[]; limit: number }) => {
			const root = guard(cwd);
			return findFiles(root, pattern, options);
		},
	};
	const lsOps = {
		exists: findOps.exists,
		stat: (path: string) => stat(guard(path)),
		readdir: (path: string) => readdir(guard(path)),
	};
	return asTools([
		createReadToolDefinition(workspace, { operations: readOps }),
		createBashToolDefinition(workspace, {
			operations: createLocalBashOperations(),
			spawnHook: (context) => ({
				...context,
				cwd: workspace,
				env: { ...context.env, ...env },
			}),
		}),
		createEditToolDefinition(workspace, { operations: editOps }),
		createWriteToolDefinition(workspace, { operations: writeOps }),
		createGrepToolDefinition(workspace, { operations: grepOps }),
		createFindToolDefinition(workspace, { operations: findOps }),
		createLsToolDefinition(workspace, { operations: lsOps }),
	]);
}

function runBuffer(
	command: string,
	args: string[],
	options: { signal?: AbortSignal; input?: string | Buffer } = {},
): Promise<Buffer> {
	return new Promise((resolvePromise, reject) => {
		const child = spawn(command, args, { stdio: [options.input === undefined ? "ignore" : "pipe", "pipe", "pipe"] });
		const stdout: Buffer[] = [];
		let stderr = "";
		const abort = () => child.kill("SIGTERM");
		options.signal?.addEventListener("abort", abort, { once: true });
		if (options.input !== undefined && child.stdin) child.stdin.end(options.input);
		child.stdout?.on("data", (chunk) => {
			stdout.push(Buffer.from(chunk));
		});
		child.stderr?.on("data", (chunk) => {
			stderr += chunk.toString();
		});
		child.on("error", reject);
		child.on("close", (code) => {
			options.signal?.removeEventListener("abort", abort);
			if (code === 0) resolvePromise(Buffer.concat(stdout));
			else
				reject(
					new Error(
						stderr.trim() || Buffer.concat(stdout).toString().trim() || `${command} exited with code ${code}`,
					),
				);
		});
	});
}

async function run(command: string, args: string[], options: { signal?: AbortSignal } = {}): Promise<string> {
	return (await runBuffer(command, args, options)).toString().trim();
}

async function dockerContainer(
	runtime: RuntimeConfig,
	workspace: string,
): Promise<{ id: string; cleanup(): Promise<void> }> {
	const image = "image" in runtime && typeof runtime.image === "string" ? runtime.image : "node:22-bookworm";
	const args = [
		"run",
		"--rm",
		"-d",
		"-w",
		GUEST_WORKSPACE,
		"-v",
		`${workspace}:${GUEST_WORKSPACE}`,
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

function dockerCwd(workspace: string, cwd: string): string {
	return guestCwd(workspace, cwd);
}

function dockerPath(workspace: string, inputPath: string): string {
	return guestPath(workspace, inputPath);
}

function dockerExec(containerId: string, args: string[], options: { input?: string | Buffer } = {}): Promise<Buffer> {
	return runBuffer("docker", ["exec", ...(options.input === undefined ? [] : ["-i"]), containerId, ...args], options);
}

function dockerFileTools(containerId: string, workspace: string): ToolDefinition<any, any, any>[] {
	const readOps = {
		readFile: (path: string) => dockerExec(containerId, ["cat", assertGuestPath(dockerPath(workspace, path))]),
		access: async (path: string) => {
			await dockerExec(containerId, ["test", "-e", assertGuestPath(dockerPath(workspace, path))]);
		},
	};
	const writeOps = {
		writeFile: async (path: string, content: string) => {
			const resolved = assertGuestPath(dockerPath(workspace, path));
			await dockerExec(containerId, ["sh", "-lc", 'cat > "$1"', "sh", resolved], { input: content });
		},
		mkdir: async (path: string) => {
			await dockerExec(containerId, ["mkdir", "-p", assertGuestPath(dockerPath(workspace, path))]);
		},
	};
	const grepOps = {
		isDirectory: async (path: string) => {
			await dockerExec(containerId, ["test", "-d", assertGuestPath(dockerPath(workspace, path))]);
			return true;
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
			const root = assertGuestPath(dockerPath(workspace, cwd));
			const matcher = globPattern(pattern.includes("/") ? pattern : `**/${pattern}`);
			const output = await dockerExec(containerId, ["find", root, "-type", "f"]);
			const paths = output
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
			return paths;
		},
	};
	const lsOps = {
		exists: findOps.exists,
		stat: async (path: string) => {
			const isDirectory = await dockerExec(containerId, ["test", "-d", assertGuestPath(dockerPath(workspace, path))])
				.then(() => true)
				.catch(() => false);
			return { isDirectory: () => isDirectory };
		},
		readdir: async (path: string) => {
			const output = await dockerExec(containerId, [
				"find",
				assertGuestPath(dockerPath(workspace, path)),
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
	return asTools([
		createReadToolDefinition(GUEST_WORKSPACE, { operations: readOps }),
		createEditToolDefinition(GUEST_WORKSPACE, { operations: { ...readOps, ...writeOps } }),
		createWriteToolDefinition(GUEST_WORKSPACE, { operations: writeOps }),
		createGrepToolDefinition(GUEST_WORKSPACE, { operations: grepOps }),
		createFindToolDefinition(GUEST_WORKSPACE, { operations: findOps }),
		createLsToolDefinition(GUEST_WORKSPACE, { operations: lsOps }),
	]);
}

function dockerBashOperations(
	containerId: string,
	workspace: string,
	env: Record<string, string> | undefined,
): BashOperations {
	return {
		exec(command, cwd, options) {
			return new Promise((resolvePromise, reject) => {
				const args = [
					"exec",
					"-w",
					dockerCwd(workspace, cwd),
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

/**
 * Builds Pi tool definitions for the configured runtime.
 *
 * Host file tools are workspace-constrained. Host bash is not a hard sandbox:
 * use Docker or another sandbox runtime for untrusted command execution.
 */
export async function createRuntimeTools(runtime: RuntimeConfig | undefined, workspace: string): Promise<RuntimeTools> {
	const kind = runtime?.kind ?? "host";
	if (kind === "host") {
		return { tools: hostFileTools(workspace, runtime?.env), async cleanup() {} };
	}
	if (runtime?.kind === "docker") {
		const container = await dockerContainer(runtime, workspace);
		const env = runtime.env;
		return {
			tools: asTools([
				...dockerFileTools(container.id, workspace),
				createBashToolDefinition(GUEST_WORKSPACE, {
					operations: dockerBashOperations(container.id, workspace, env),
				}),
			]),
			cleanup: container.cleanup,
		};
	}
	throw new Error(`Unsupported runtime: ${kind}`);
}
