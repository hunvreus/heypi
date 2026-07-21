import { RealFSProvider, VM, type VMOptions, type VmFs } from "@earendil-works/gondolin";
import { createRuntimeToolDefinitions, type RuntimeConfig, type RuntimeFileSystem } from "@hunvreus/heypi/runtime";

export type GondolinRuntimeOptions = Omit<VMOptions, "env" | "vfs"> & {
	workspace?: string;
	env?: Record<string, string>;
	shell?: string;
};

const MUTATING_PROVIDER_METHODS = new Set([
	"appendFile",
	"appendFileSync",
	"copyFile",
	"copyFileSync",
	"link",
	"linkSync",
	"mkdir",
	"mkdirSync",
	"rename",
	"renameSync",
	"rmdir",
	"rmdirSync",
	"symlink",
	"symlinkSync",
	"unlink",
	"unlinkSync",
	"writeFile",
	"writeFileSync",
]);

function readOnly(root: string): RealFSProvider {
	const provider = new RealFSProvider(root);
	return new Proxy(provider, {
		get(target, property) {
			if (property === "readonly") return true;
			if (typeof property === "string" && MUTATING_PROVIDER_METHODS.has(property)) {
				return () => {
					throw new Error("read-only filesystem");
				};
			}
			const value = Reflect.get(target, property, target);
			if ((property === "open" || property === "openSync") && typeof value === "function") {
				return (path: string, flags: string, mode?: number) => {
					if (/[wa+]/.test(flags)) throw new Error("read-only filesystem");
					return value.call(target, path, flags, mode);
				};
			}
			return typeof value === "function" ? value.bind(target) : value;
		},
	});
}

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
	const { workspace, env, shell = "/bin/bash", ...vmOptions } = options;
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
						...(context.skills ? { "/agent/skills": readOnly(context.skills) } : {}),
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
