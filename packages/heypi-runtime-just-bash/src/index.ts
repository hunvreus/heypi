import { createRuntimeToolDefinitions, type RuntimeConfig, type RuntimeFileSystem } from "@hunvreus/heypi/runtime";
import type { BashOptions, IFileSystem } from "just-bash";
import { Bash, InMemoryFs, MountableFs, ReadWriteFs } from "just-bash";

export type JustBashRuntimeOptions = Omit<BashOptions, "cwd" | "env" | "fs"> & {
	workspace?: string;
	env?: Record<string, string>;
};

function runtimeFs(fs: IFileSystem): RuntimeFileSystem {
	return {
		async access(path) {
			if (!(await fs.exists(path))) throw new Error(`No such file or directory: ${path}`);
		},
		mkdir: (path) => fs.mkdir(path, { recursive: true }),
		readFile: (path) => fs.readFileBuffer(path),
		readdir: (path) => fs.readdir(path),
		stat: async (path) => {
			const entry = await fs.stat(path);
			return { isDirectory: () => entry.isDirectory };
		},
		writeFile: (path, content) => fs.writeFile(path, content),
	};
}

/** Run Pi's core file and bash tools inside the just-bash interpreter. */
export function justBash(options: JustBashRuntimeOptions = {}): RuntimeConfig {
	const { workspace, env, ...bashOptions } = options;
	return {
		kind: "just-bash",
		workspace,
		env,
		async provider(context) {
			const fs = new MountableFs({ base: new InMemoryFs() });
			fs.mount("/workspace", new ReadWriteFs({ root: context.workspace }));
			if (context.shared) fs.mount("/shared", new ReadWriteFs({ root: context.shared }));
			const bash = new Bash({ ...bashOptions, cwd: "/workspace", env: context.env, fs });
			return {
				tools: createRuntimeToolDefinitions({
					fs: runtimeFs(fs),
					roots: context,
					bash: {
						async exec(command, cwd, run) {
							const controller = new AbortController();
							const abort = () => controller.abort();
							run.signal?.addEventListener("abort", abort, { once: true });
							const timer = run.timeout ? setTimeout(abort, run.timeout * 1000) : undefined;
							try {
								const result = await bash.exec(command, {
									cwd,
									env: Object.fromEntries(
										Object.entries(run.env ?? {}).filter(
											(entry): entry is [string, string] => entry[1] !== undefined,
										),
									),
									signal: controller.signal,
								});
								if (result.stdout) run.onData(Buffer.from(result.stdout));
								if (result.stderr) run.onData(Buffer.from(result.stderr));
								return { exitCode: result.exitCode };
							} finally {
								if (timer) clearTimeout(timer);
								run.signal?.removeEventListener("abort", abort);
							}
						},
					},
				}),
				async cleanup() {},
			};
		},
	};
}
