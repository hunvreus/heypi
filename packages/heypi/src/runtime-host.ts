import { access, lstat, mkdir, readdir, readFile, realpath, stat, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { createLocalBashOperations, type ToolDefinition } from "@earendil-works/pi-coding-agent";
import { assertInside, GUEST_SHARED, GUEST_WORKSPACE, hostPath, type RuntimeRoots } from "./runtime-path.js";
import { createRuntimeToolDefinitions, type RuntimeFileSystem } from "./runtime-provider.js";

function shellQuote(value: string): string {
	return `'${value.replaceAll("'", "'\\''")}'`;
}

function quoted(value: string, quote: "'" | '"' | undefined): string {
	if (quote === "'") return value.replaceAll("'", "'\\''");
	if (quote === '"') return value.replaceAll(/([\\"$`])/g, "\\$1");
	return shellQuote(value);
}

const SHELL_BOUNDARIES = " \t\r\n'\";|&()<>{}[],:=";

function guestMapping(
	command: string,
	index: number,
	mappings: Array<{ guest: string; host: string }>,
	escaped = false,
): { guest: string; host: string } | undefined {
	const previous = command[index - 1];
	if (!escaped && previous !== undefined && !SHELL_BOUNDARIES.includes(previous)) return undefined;
	return mappings.find(({ guest }) => {
		if (!command.startsWith(guest, index)) return false;
		const next = command[index + guest.length];
		return next === undefined || next === "/" || next === "$" || next === "`" || SHELL_BOUNDARIES.includes(next);
	});
}

function rewriteGuestPaths(command: string, roots: RuntimeRoots): string {
	const mappings = [
		{ guest: GUEST_WORKSPACE, host: roots.workspace },
		...(roots.shared ? [{ guest: GUEST_SHARED, host: roots.shared }] : []),
	];
	let output = "";
	let quote: "'" | '"' | undefined;
	for (let index = 0; index < command.length; ) {
		const character = command[index] ?? "";
		if (character === "\\" && quote !== "'") {
			if (!quote && command[index + 1] === "/") {
				const mapping = guestMapping(command, index + 1, mappings, true);
				if (mapping) {
					output += quoted(mapping.host, quote);
					index += mapping.guest.length + 1;
					continue;
				}
			}
			output += command.slice(index, index + 2);
			index += 2;
			continue;
		}
		if (character === "'" || character === '"') {
			if (!quote) quote = character;
			else if (quote === character) quote = undefined;
			output += character;
			index++;
			continue;
		}
		const mapping = guestMapping(command, index, mappings);
		if (mapping) {
			output += quoted(mapping.host, quote);
			index += mapping.guest.length;
			continue;
		}
		output += character;
		index++;
	}
	return output;
}

async function safeHostPath(roots: RuntimeRoots, path: string, create = false): Promise<string> {
	const target = hostPath(roots, path);
	const root = path === GUEST_SHARED || path.startsWith(`${GUEST_SHARED}/`) ? roots.shared : roots.workspace;
	if (!root) throw new Error(`path escapes runtime workspace: ${path}`);
	const canonicalRoot = await realpath(root);
	if (!create) {
		assertInside(canonicalRoot, await realpath(target));
		return target;
	}
	let targetExists = true;
	try {
		await lstat(target);
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
		targetExists = false;
	}
	if (targetExists) {
		assertInside(canonicalRoot, await realpath(target));
		return target;
	}
	let existing = dirname(target);
	while (true) {
		try {
			assertInside(canonicalRoot, await realpath(existing));
			return target;
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "ENOENT" || existing === target) throw error;
			const parent = dirname(existing);
			if (parent === existing) throw error;
			existing = parent;
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
	const local = createLocalBashOperations(process.platform === "win32" ? undefined : { shellPath: "/bin/bash" });
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
