import { access, mkdir, readdir, readFile, stat, writeFile } from "node:fs/promises";
import {
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
import { GUEST_SHARED, GUEST_WORKSPACE, guestPath, hostPath, type RuntimeRoots } from "./runtime-path.js";
import { findFiles, guardPathInput, mapPathInput } from "./runtime-util.js";

function hostCwd(roots: RuntimeRoots, inputPath: string | undefined): { host: string; guest: string } {
	if (!inputPath || inputPath === ".") return { host: roots.workspace, guest: GUEST_WORKSPACE };
	return { host: hostPath(roots, inputPath), guest: guestPath(roots, inputPath) };
}

function shellQuote(value: string): string {
	return `'${value.replaceAll("'", "'\\''")}'`;
}

function rewriteGuestPaths(command: string, roots: RuntimeRoots): string {
	let rewritten = command.replaceAll(GUEST_WORKSPACE, shellQuote(roots.workspace));
	if (roots.shared) rewritten = rewritten.replaceAll(GUEST_SHARED, shellQuote(roots.shared));
	return rewritten;
}

export function createHostRuntimeTools(
	roots: RuntimeRoots,
	env?: Record<string, string>,
): ToolDefinition<any, any, any>[] {
	const guard = (path: string) => hostPath(roots, path);
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
			const root = hostCwd(roots, cwd);
			return (await findFiles(root.host, pattern, options)).map((path) => `${root.guest}/${path}`);
		},
	};
	const lsOps = {
		exists: findOps.exists,
		stat: (path: string) => stat(guard(path)),
		readdir: (path: string) => readdir(guard(path)),
	};
	return [
		createReadToolDefinition(GUEST_WORKSPACE, { operations: readOps }),
		createBashToolDefinition(GUEST_WORKSPACE, {
			operations: createLocalBashOperations(),
			spawnHook: (context) => ({
				...context,
				cwd: roots.workspace,
				command: rewriteGuestPaths(context.command, roots),
				env: { ...context.env, ...env },
			}),
		}),
		createEditToolDefinition(GUEST_WORKSPACE, { operations: { ...readOps, ...writeOps } }),
		createWriteToolDefinition(GUEST_WORKSPACE, { operations: writeOps }),
		mapPathInput(createGrepToolDefinition(roots.workspace, { operations: grepOps }), guard, ["path"]),
		createFindToolDefinition(GUEST_WORKSPACE, { operations: findOps }),
		guardPathInput(createLsToolDefinition(GUEST_WORKSPACE, { operations: lsOps }), guard, ["path"]),
	];
}
