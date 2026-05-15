import { mkdirSync } from "node:fs";
import { mkdir, readdir, readFile, stat, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, relative } from "node:path";
import type { RuntimeLimits } from "../config.js";
import { assertNotAborted, assertSize, runtimeLimits } from "./limits.js";
import { match } from "./match.js";
import { hostPath } from "./path.js";
import { executeBash } from "./shell.js";
import type { GrepHit, LsEntry, Runtime } from "./types.js";

const PATH = "/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin";

export function hostBash(input: {
	root: string;
	guarded?: boolean;
	timeoutMs?: number;
	env?: Record<string, string>;
	limits?: RuntimeLimits;
}): Runtime {
	const root = input.root;
	mkdirSync(root, { recursive: true });
	const timeoutMs = input.timeoutMs ?? 120_000;
	const limits = runtimeLimits(input.limits);
	return {
		name: input.guarded ? "guarded-bash" : "host-bash",
		root,
		capabilities: { bash: true, read: true, write: true, edit: true, grep: true, find: true, ls: true },
		bash: async ({ command, timeoutMs: override, signal }) => {
			const env = {
				PATH,
				HOME: homedir(),
				LANG: "C.UTF-8",
				LC_ALL: "C.UTF-8",
				TERM: "xterm-256color",
				...input.env,
			};
			const cmd = input.guarded ? `set -euo pipefail\n${command}` : command;
			return await executeBash(cmd, { cwd: root, timeoutMs: override ?? timeoutMs, env, signal });
		},
		read: async ({ path, offset, limit, signal }) => {
			assertNotAborted(signal);
			const file = hostPath(root, path);
			const info = await stat(file);
			assertSize(info.size, limits.maxFileBytes, path);
			const text = await readFile(file, "utf8");
			const lines = text.split(/\r?\n/);
			const start = offset ? Math.max(0, offset - 1) : 0;
			const end = limit ? start + limit : lines.length;
			return { path, text: lines.slice(start, end).join("\n"), lines: lines.length };
		},
		write: async ({ path, content }) => {
			assertSize(Buffer.byteLength(content), limits.maxFileBytes, path);
			const file = hostPath(root, path);
			await mkdir(dirname(file), { recursive: true });
			await writeFile(file, content, "utf8");
			return { path, bytes: Buffer.byteLength(content) };
		},
		edit: async ({ path, oldText, newText, replaceAll }) => {
			const file = hostPath(root, path);
			const info = await stat(file);
			assertSize(info.size, limits.maxFileBytes, path);
			const text = await readFile(file, "utf8");
			const count = text.split(oldText).length - 1;
			if (count === 0) throw new Error(`text not found in ${path}`);
			if (!replaceAll && count > 1) throw new Error(`text is not unique in ${path}`);
			const next = replaceAll ? text.replaceAll(oldText, newText) : text.replace(oldText, newText);
			assertSize(Buffer.byteLength(next), limits.maxFileBytes, path);
			await writeFile(file, next, "utf8");
			return { path, replacements: replaceAll ? count : 1 };
		},
		grep: async ({ query, path = ".", maxResults = 100, signal }) => {
			const hits: GrepHit[] = [];
			let scanned = 0;
			for (const file of await files(root, hostPath(root, path), limits.maxEntries, signal)) {
				assertNotAborted(signal);
				const info = await stat(file).catch(() => undefined);
				if (!info) continue;
				assertSize(info.size, limits.maxFileBytes, relative(root, file));
				scanned += info.size;
				assertSize(scanned, limits.maxScanBytes, "scan");
				const text = await readFile(file, "utf8").catch(() => "");
				const lines = text.split(/\r?\n/);
				for (let i = 0; i < lines.length; i++) {
					if (!lines[i].includes(query)) continue;
					hits.push({ path: relative(root, file), line: i + 1, text: lines[i].trim() });
					if (hits.length >= maxResults) return { hits };
				}
			}
			return { hits };
		},
		find: async ({ pattern, path = ".", maxResults = 1000, signal }) => {
			const out: string[] = [];
			for (const file of await paths(root, hostPath(root, path), Math.min(maxResults, limits.maxEntries), signal)) {
				assertNotAborted(signal);
				const rel = relative(root, file);
				if (!match(rel, pattern)) continue;
				out.push(rel);
				if (out.length >= maxResults) break;
			}
			return { paths: out };
		},
		ls: async ({ path = ".", signal }) => {
			assertNotAborted(signal);
			const base = hostPath(root, path);
			const entries: LsEntry[] = [];
			for (const name of await readdir(base)) {
				assertNotAborted(signal);
				if (entries.length >= limits.maxEntries) break;
				const full = join(base, name);
				const info = await stat(full);
				entries.push({
					name,
					path: relative(root, full),
					type: info.isDirectory() ? "directory" : info.isFile() ? "file" : "other",
					size: info.size,
				});
			}
			return { entries };
		},
	};
}

async function paths(root: string, start: string, maxEntries: number, signal?: AbortSignal): Promise<string[]> {
	assertNotAborted(signal);
	const info = await stat(start);
	if (info.isFile()) return [start];
	const out: string[] = [start];
	for (const name of await readdir(start)) {
		assertNotAborted(signal);
		if (out.length >= maxEntries) break;
		out.push(...(await paths(root, join(start, name), maxEntries - out.length, signal)));
	}
	return out.filter((path) => path !== root);
}

async function files(root: string, start: string, maxEntries: number, signal?: AbortSignal): Promise<string[]> {
	const all = await paths(root, start, maxEntries, signal);
	const out: string[] = [];
	for (const path of all) {
		assertNotAborted(signal);
		if ((await stat(path)).isFile()) out.push(path);
	}
	return out;
}
