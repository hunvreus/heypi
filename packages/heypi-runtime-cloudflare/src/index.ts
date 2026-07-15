import type { ExecutionSession, ISandbox } from "@cloudflare/sandbox";
import {
	createRuntimeToolDefinitions,
	downloadRuntimeRoots,
	mirrorRuntimeFileSystem,
	type RuntimeConfig,
	type RuntimeContext,
	type RuntimeFileSystem,
	uploadRuntimeRoots,
} from "@hunvreus/heypi/runtime";

export type CloudflareRuntimeOptions = {
	workspace?: string;
	env?: Record<string, string>;
	sandbox: ISandbox | ((context: RuntimeContext) => Promise<ISandbox> | ISandbox);
};

function shellQuote(value: string): string {
	return `'${value.replaceAll("'", "'\\''")}'`;
}

function runtimeFs(session: ExecutionSession): RuntimeFileSystem {
	return {
		async access(path) {
			if (!(await session.exists(path)).exists) throw new Error(`No such file or directory: ${path}`);
		},
		async mkdir(path) {
			await session.mkdir(path, { recursive: true });
		},
		async readFile(path) {
			const result = await session.readFile(path, { encoding: "base64" });
			return Buffer.from(result.content, "base64");
		},
		async readdir(path) {
			const result = await session.listFiles(path);
			return result.files.map((file) => file.name);
		},
		async stat(path) {
			const result = await session.exec(`test -d ${shellQuote(path)}`);
			return { isDirectory: () => result.exitCode === 0 };
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
			try {
				await uploadRuntimeRoots(remote, context);
			} catch (error) {
				await sandbox.deleteSession(session.id).catch(() => undefined);
				throw error;
			}
			return {
				tools: createRuntimeToolDefinitions({
					fs: mirrorRuntimeFileSystem(remote, context),
					roots: context,
					bash: {
						async exec(command, cwd, run) {
							const result = await session.exec(command, {
								cwd,
								env: run.env,
								timeout: run.timeout ? run.timeout * 1000 : undefined,
								signal: run.signal,
								stream: true,
								onOutput: (_stream, data) => run.onData(Buffer.from(data)),
							});
							await downloadRuntimeRoots(remote, context);
							return { exitCode: result.exitCode };
						},
					},
				}),
				async cleanup() {
					try {
						await downloadRuntimeRoots(remote, context);
					} finally {
						await sandbox.deleteSession(session.id);
					}
				},
			};
		},
	};
}
