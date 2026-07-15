import { Writable } from "node:stream";
import {
	createRuntimeToolDefinitions,
	downloadRuntimeRoots,
	mirrorRuntimeFileSystem,
	type RuntimeConfig,
	type RuntimeContext,
	type RuntimeFileSystem,
	uploadRuntimeRoots,
} from "@hunvreus/heypi/runtime";
import { Sandbox } from "@vercel/sandbox";

type CreateOptions = NonNullable<Parameters<typeof Sandbox.create>[0]>;

export type VercelRuntimeOptions = {
	workspace?: string;
	env?: Record<string, string>;
	sandbox?: CreateOptions;
	create?(options: CreateOptions): Promise<Sandbox>;
};

function runtimeFs(sandbox: Sandbox): RuntimeFileSystem {
	return {
		access: (path) => sandbox.fs.access(path),
		mkdir: async (path) => {
			await sandbox.fs.mkdir(path, { recursive: true });
		},
		readFile: (path) => sandbox.fs.readFile(path),
		readdir: (path) => sandbox.fs.readdir(path),
		stat: (path) => sandbox.fs.stat(path),
		writeFile: (path, content) => sandbox.fs.writeFile(path, content),
	};
}

function output(onData: (data: Buffer) => void): Writable {
	return new Writable({
		write(chunk, _encoding, callback) {
			onData(Buffer.from(chunk));
			callback();
		},
	});
}

async function createSandbox(options: VercelRuntimeOptions, context: RuntimeContext): Promise<Sandbox> {
	const params = {
		...(options.sandbox ?? {}),
		env: { ...options.sandbox?.env, ...context.env },
	} as CreateOptions;
	return options.create ? options.create(params) : Sandbox.create(params);
}

/** Run Pi's core tools in a managed Vercel Sandbox. */
export function vercel(options: VercelRuntimeOptions = {}): RuntimeConfig {
	return {
		kind: "vercel",
		workspace: options.workspace,
		env: options.env,
		async provider(context) {
			const sandbox = await createSandbox(options, context);
			const remote = runtimeFs(sandbox);
			try {
				await uploadRuntimeRoots(remote, context);
			} catch (error) {
				await sandbox.stop().catch(() => undefined);
				throw error;
			}
			return {
				tools: createRuntimeToolDefinitions({
					fs: mirrorRuntimeFileSystem(remote, context),
					roots: context,
					bash: {
						async exec(command, cwd, run) {
							const result = await sandbox.runCommand({
								cmd: "/bin/sh",
								args: ["-lc", command],
								cwd,
								env: Object.fromEntries(
									Object.entries(run.env ?? {}).filter(
										(entry): entry is [string, string] => entry[1] !== undefined,
									),
								),
								signal: run.signal,
								timeoutMs: run.timeout ? run.timeout * 1000 : undefined,
								stdout: output(run.onData),
								stderr: output(run.onData),
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
						await sandbox.stop();
					}
				},
			};
		},
	};
}
