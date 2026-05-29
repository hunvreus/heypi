import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { Bash, type BashOptions, type IFileSystem, ReadWriteFs } from "just-bash";
import type { JustBashConfig, RuntimeLimits } from "../config.js";
import { assertNotAborted, assertSize, runtimeLimits } from "./limits.js";
import { match } from "./match.js";
import { virtualPath } from "./path.js";
import { clip } from "./shell.js";
import type { GrepHit, LsEntry, Runtime } from "./types.js";

export function justBash(input: {
	root: string;
	timeoutMs?: number;
	options?: JustBashConfig;
	limits?: RuntimeLimits;
}): Runtime {
	const root = input.root;
	const fs = input.options?.filesystem ?? defaultFs(root);
	const timeoutMs = input.timeoutMs ?? 120_000;
	const limits = runtimeLimits(input.limits);
	const bashOptions: BashOptions = {
		files: input.options?.files,
		fs,
		cwd: "/",
		commands: input.options?.commands,
		customCommands: input.options?.customCommands,
		defenseInDepth: input.options?.defenseInDepth ?? true,
		javascript: input.options?.javascript,
		network: input.options?.network,
		python: input.options?.python,
		env: {
			HOME: "/",
			LANG: "C.UTF-8",
			LC_ALL: "C.UTF-8",
			TERM: "xterm-256color",
			...input.options?.env,
		},
	};

	return {
		name: "just-bash",
		root,
		bash: async ({ command, timeoutMs: override, signal }) => {
			const start = Date.now();
			const controller = new AbortController();
			const onAbort = () => controller.abort();
			const timer = setTimeout(onAbort, override ?? timeoutMs);
			signal?.addEventListener("abort", onAbort, { once: true });
			try {
				const result = await new Bash(bashOptions).exec(command, { signal: controller.signal });
				return {
					code: result.exitCode,
					out: clip(result.stdout),
					err: clip(result.stderr),
					ms: Date.now() - start,
				};
			} catch (error) {
				return {
					code: signal?.aborted ? 130 : controller.signal.aborted ? 124 : 1,
					out: "",
					err: signal?.aborted
						? "Command cancelled"
						: controller.signal.aborted
							? "Command timed out"
							: error instanceof Error
								? error.message
								: String(error),
					ms: Date.now() - start,
				};
			} finally {
				clearTimeout(timer);
				signal?.removeEventListener("abort", onAbort);
			}
		},
		read: async ({ path, offset, limit, signal }) => {
			assertNotAborted(signal);
			const file = virtualPath(path);
			const info = await fs.stat(file);
			assertSize(info.size, limits.maxFileBytes, path);
			const text = await fs.readFile(file);
			const lines = text.split(/\r?\n/);
			const start = offset ? Math.max(0, offset - 1) : 0;
			const end = limit ? start + limit : lines.length;
			return { path, text: lines.slice(start, end).join("\n"), lines: lines.length };
		},
		write: async ({ path, content }) => {
			assertSize(Buffer.byteLength(content), limits.maxFileBytes, path);
			const file = virtualPath(path);
			await mkdirp(fs, dirname(file));
			await fs.writeFile(file, content);
			return { path, bytes: Buffer.byteLength(content) };
		},
		edit: async ({ path, oldText, newText, replaceAll }) => {
			const file = virtualPath(path);
			const info = await fs.stat(file);
			assertSize(info.size, limits.maxFileBytes, path);
			const text = await fs.readFile(file);
			const count = text.split(oldText).length - 1;
			if (count === 0) throw new Error(`text not found in ${path}`);
			if (!replaceAll && count > 1) throw new Error(`text is not unique in ${path}`);
			const next = replaceAll ? text.replaceAll(oldText, newText) : text.replace(oldText, newText);
			assertSize(Buffer.byteLength(next), limits.maxFileBytes, path);
			await fs.writeFile(file, next);
			return { path, replacements: replaceAll ? count : 1 };
		},
		grep: async ({ query, path = ".", maxResults = 100, signal }) => {
			const hits: GrepHit[] = [];
			let scanned = 0;
			for (const file of await files(fs, virtualPath(path), limits.maxEntries, signal)) {
				assertNotAborted(signal);
				const info = await fs.stat(file).catch(() => undefined);
				if (!info) continue;
				assertSize(info.size, limits.maxFileBytes, file);
				scanned += info.size;
				assertSize(scanned, limits.maxScanBytes, "scan");
				const text = await fs.readFile(file).catch(() => "");
				const lines = text.split(/\r?\n/);
				for (let i = 0; i < lines.length; i++) {
					if (!lines[i].includes(query)) continue;
					hits.push({ path: trim(file), line: i + 1, text: lines[i].trim() });
					if (hits.length >= maxResults) return { hits };
				}
			}
			return { hits };
		},
		find: async ({ pattern, path = ".", maxResults = 1000, signal }) => {
			const out: string[] = [];
			for (const file of await paths(fs, virtualPath(path), Math.min(maxResults, limits.maxEntries), signal)) {
				assertNotAborted(signal);
				const rel = trim(file);
				if (!match(rel, pattern)) continue;
				out.push(rel);
				if (out.length >= maxResults) break;
			}
			return { paths: out };
		},
		ls: async ({ path = ".", signal }) => {
			assertNotAborted(signal);
			const base = virtualPath(path);
			const entries: LsEntry[] = [];
			for (const name of await fs.readdir(base)) {
				assertNotAborted(signal);
				if (entries.length >= limits.maxEntries) break;
				const full = base === "/" ? `/${name}` : `${base}/${name}`;
				const info = await fs.stat(full);
				entries.push({
					name,
					path: trim(full),
					type: info.isDirectory ? "directory" : info.isFile ? "file" : "other",
					size: info.size,
				});
			}
			return { entries };
		},
	};
}

function defaultFs(root: string): IFileSystem {
	mkdirSync(root, { recursive: true });
	return new ReadWriteFs({ root });
}

async function mkdirp(fs: IFileSystem, path: string): Promise<void> {
	if (!path || path === "/" || (await fs.exists(path))) return;
	await mkdirp(fs, dirname(path));
	await fs.mkdir(path).catch(() => undefined);
}

async function paths(fs: IFileSystem, start: string, maxEntries: number, signal?: AbortSignal): Promise<string[]> {
	assertNotAborted(signal);
	const info = await fs.stat(start);
	if (info.isFile) return [start];
	const out: string[] = [start];
	for (const name of await fs.readdir(start)) {
		assertNotAborted(signal);
		if (out.length >= maxEntries) break;
		out.push(...(await paths(fs, start === "/" ? `/${name}` : `${start}/${name}`, maxEntries - out.length, signal)));
	}
	return out.filter((path) => path !== "/");
}

async function files(fs: IFileSystem, start: string, maxEntries: number, signal?: AbortSignal): Promise<string[]> {
	const all = await paths(fs, start, maxEntries, signal);
	const out: string[] = [];
	for (const path of all) {
		assertNotAborted(signal);
		if ((await fs.stat(path)).isFile) out.push(path);
	}
	return out;
}

function trim(path: string): string {
	return path.replace(/^\//, "");
}
