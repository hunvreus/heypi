import { access, mkdir, readdir, readFile, realpath, stat, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { createLocalBashOperations, type ToolDefinition } from "@earendil-works/pi-coding-agent";
import { assertInside, GUEST_SHARED, GUEST_WORKSPACE, hostPath, type RuntimeRoots } from "./runtime-path.js";
import { createRuntimeToolDefinitions, type RuntimeFileSystem } from "./runtime-provider.js";

function shellQuote(value: string): string {
	return `'${value.replaceAll("'", "'\\''")}'`;
}

function rewriteGuestPaths(command: string, roots: RuntimeRoots): string {
	let rewritten = command.replaceAll(GUEST_WORKSPACE, shellQuote(roots.workspace));
	if (roots.shared) rewritten = rewritten.replaceAll(GUEST_SHARED, shellQuote(roots.shared));
	return rewritten;
}

async function safeHostPath(roots: RuntimeRoots, path: string, parent = false): Promise<string> {
	const target = hostPath(roots, path);
	const root = path === GUEST_SHARED || path.startsWith(`${GUEST_SHARED}/`) ? roots.shared : roots.workspace;
	if (!root) throw new Error(`path escapes runtime workspace: ${path}`);
	let existing = parent ? dirname(target) : target;
	while (true) {
		try {
			assertInside(await realpath(root), await realpath(existing));
			return target;
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "ENOENT" || existing === root) throw error;
			existing = dirname(existing);
		}
	}
}

export function createHostRuntimeTools(
	roots: RuntimeRoots,
	env?: Record<string, string>,
): ToolDefinition<any, any, any>[] {
	const fs: RuntimeFileSystem = {
		access: async (path) => access(await safeHostPath(roots, path)),
		mkdir: async (path) => {
			await mkdir(await safeHostPath(roots, path, true), { recursive: true });
		},
		readFile: async (path) => readFile(await safeHostPath(roots, path)),
		readdir: async (path) => readdir(await safeHostPath(roots, path)),
		stat: async (path) => stat(await safeHostPath(roots, path)),
		writeFile: async (path, content) => writeFile(await safeHostPath(roots, path, true), content),
	};
	const local = createLocalBashOperations();
	return createRuntimeToolDefinitions({
		fs,
		roots,
		bash: {
			exec: (command, cwd, options) =>
				local.exec(rewriteGuestPaths(command, roots), hostPath(roots, cwd), {
					...options,
					env: { ...options.env, ...env },
				}),
		},
	});
}
