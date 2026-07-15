import { RealFSProvider, VM, type VMOptions, type VmFs } from "@earendil-works/gondolin";
import { createRuntimeToolDefinitions, type RuntimeConfig, type RuntimeFileSystem } from "@hunvreus/heypi/runtime";

export type GondolinRuntimeOptions = Omit<VMOptions, "env" | "vfs"> & {
	workspace?: string;
	env?: Record<string, string>;
	shell?: string;
};

function runtimeFs(fs: VmFs): RuntimeFileSystem {
	return {
		access: (path) => fs.access(path),
		mkdir: (path) => fs.mkdir(path, { recursive: true }),
		readFile: (path) => fs.readFile(path),
		readdir: (path) => fs.listDir(path),
		stat: (path) => fs.stat(path),
		writeFile: (path, content) => fs.writeFile(path, content),
	};
}

/** Run Pi's core tools in a Gondolin micro-VM with durable bind mounts. */
export function gondolin(options: GondolinRuntimeOptions = {}): RuntimeConfig {
	const { workspace, env, shell = "/bin/sh", ...vmOptions } = options;
	return {
		kind: "gondolin",
		workspace,
		env,
		async provider(context) {
			const vm = await VM.create({
				...vmOptions,
				env: context.env,
				vfs: {
					mounts: {
						"/workspace": new RealFSProvider(context.workspace),
						...(context.shared ? { "/shared": new RealFSProvider(context.shared) } : {}),
					},
				},
			});
			return {
				tools: createRuntimeToolDefinitions({
					fs: runtimeFs(vm.fs),
					roots: context,
					bash: {
						async exec(command, cwd, run) {
							const controller = new AbortController();
							const abort = () => controller.abort();
							run.signal?.addEventListener("abort", abort, { once: true });
							const timer = run.timeout ? setTimeout(abort, run.timeout * 1000) : undefined;
							try {
								const process = vm.exec([shell, "-lc", command], {
									cwd,
									env: Object.fromEntries(
										Object.entries(run.env ?? {}).filter(
											(entry): entry is [string, string] => entry[1] !== undefined,
										),
									),
									signal: controller.signal,
									stdout: "pipe",
									stderr: "pipe",
								});
								for await (const chunk of process.output()) run.onData(chunk.data);
								const result = await process;
								return { exitCode: result.exitCode };
							} finally {
								if (timer) clearTimeout(timer);
								run.signal?.removeEventListener("abort", abort);
							}
						},
					},
				}),
				cleanup: () => vm.close(),
			};
		},
	};
}
