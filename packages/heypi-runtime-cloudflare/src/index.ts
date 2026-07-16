import type { ExecutionSession, ISandbox } from "@cloudflare/sandbox";
import {
	createRuntimeMirror,
	createRuntimeToolDefinitions,
	type RuntimeConfig,
	type RuntimeContext,
	type RuntimeMirrorFileSystem,
} from "@hunvreus/heypi/runtime";

export type CloudflareRuntimeOptions = {
	workspace?: string;
	env?: Record<string, string>;
	sandbox: ISandbox | ((context: RuntimeContext) => Promise<ISandbox> | ISandbox);
};

function shellQuote(value: string): string {
	return `'${value.replaceAll("'", "'\\''")}'`;
}

async function shell(session: ExecutionSession, command: string): Promise<string> {
	const result = await session.exec(`/bin/bash -lc ${shellQuote(command)}`);
	if (result.exitCode !== 0) throw new Error(result.stderr || `Sandbox command failed: ${result.exitCode}`);
	return result.stdout;
}

function runtimeFs(session: ExecutionSession): RuntimeMirrorFileSystem {
	return {
		async access(path) {
			if (!(await session.exists(path)).exists) throw new Error(`No such file or directory: ${path}`);
		},
		async chmod(path, mode) {
			await shell(session, `chmod ${mode.toString(8)} -- ${shellQuote(path)}`);
		},
		async mkdir(path) {
			await session.mkdir(path, { recursive: true });
		},
		async readFile(path) {
			const result = await session.readFile(path, { encoding: "base64" });
			return Buffer.from(result.content, "base64");
		},
		async readdir(path) {
			const result = await session.listFiles(path, { includeHidden: true });
			return result.files.map((file) => file.name);
		},
		async lstat(path) {
			const output = await shell(
				session,
				`if [ -L ${shellQuote(path)} ]; then kind=l; elif [ -d ${shellQuote(path)} ]; then kind=d; elif [ -f ${shellQuote(path)} ]; then kind=f; elif [ -e ${shellQuote(path)} ]; then kind=o; else exit 44; fi; printf '%s %s' "$kind" "$(stat -c '%a' -- ${shellQuote(path)})"`,
			);
			const [entry, permissions] = output.trim().split(/\s+/);
			return {
				isDirectory: () => entry === "d",
				isFile: () => entry === "f",
				isSymbolicLink: () => entry === "l",
				mode: Number.parseInt(permissions ?? "644", 8),
			};
		},
		readlink: (path) => shell(session, `readlink -- ${shellQuote(path)}`).then((value) => value.trimEnd()),
		async rm(path) {
			await shell(session, `rm -rf -- ${shellQuote(path)}`);
		},
		async stat(path) {
			const result = await session.exec(`/bin/bash -lc ${shellQuote(`test -d ${shellQuote(path)}`)}`);
			return { isDirectory: () => result.exitCode === 0 };
		},
		async symlink(target, path) {
			await shell(session, `ln -s -- ${shellQuote(target)} ${shellQuote(path)}`);
		},
		async writeFile(path, content) {
			const binary = typeof content === "string" ? Buffer.from(content) : Buffer.from(content);
			await session.writeFile(path, binary.toString("base64"), { encoding: "base64" });
		},
	};
}

async function resolveSandbox(options: CloudflareRuntimeOptions, context: RuntimeContext): Promise<ISandbox> {
	return typeof options.sandbox === "function" ? options.sandbox(context) : options.sandbox;
}

/** Run Pi's core tools in an explicit Cloudflare Sandbox SDK session. */
export function cloudflare(options: CloudflareRuntimeOptions): RuntimeConfig {
	return {
		kind: "cloudflare",
		workspace: options.workspace,
		env: options.env,
		async provider(context) {
			const sandbox = await resolveSandbox(options, context);
			const session = await sandbox.createSession({ cwd: "/workspace", env: context.env });
			const remote = runtimeFs(session);
			const mirror = createRuntimeMirror(remote, context);
			return {
				prepare: mirror.upload,
				tools: createRuntimeToolDefinitions({
					fs: mirror.fs,
					roots: context,
					bash: {
						async exec(command, cwd, run) {
							const result = await mirror.downloadAfter(() =>
								session.exec(`/bin/bash -lc ${shellQuote(command)}`, {
									cwd,
									env: run.env,
									timeout: run.timeout ? run.timeout * 1000 : undefined,
									signal: run.signal,
									stream: true,
									onOutput: (_stream, data) => run.onData(Buffer.from(data)),
								}),
							);
							return { exitCode: result.exitCode };
						},
					},
				}),
				async cleanup() {
					try {
						await mirror.download();
					} finally {
						await sandbox.deleteSession(session.id);
					}
				},
			};
		},
	};
}
