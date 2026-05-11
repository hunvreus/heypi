import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { Bash, type BashOptions, type IFileSystem, ReadWriteFs } from "just-bash";
import type { JustBashConfig } from "../config.js";
import { match } from "./match.js";
import { virtualPath } from "./path.js";
import { clip } from "./shell.js";
import type { GrepHit, LsEntry, Runtime } from "./types.js";

export function justBash(input: { root: string; timeoutMs?: number; options?: JustBashConfig }): Runtime {
	const root = input.root;
	mkdirSync(root, { recursive: true });
	const fs = input.options?.filesystem ?? new ReadWriteFs({ root });
	const timeoutMs = input.timeoutMs ?? 120_000;
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
		capabilities: { bash: true, read: true, write: true, edit: true, grep: true, find: true, ls: true },
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
		read: async ({ path, offset, limit }) => {
			const text = await fs.readFile(virtualPath(path));
			const lines = text.split(/\r?\n/);
			const start = offset ? Math.max(0, offset - 1) : 0;
			const end = limit ? start + limit : lines.length;
			return { path, text: lines.slice(start, end).join("\n"), lines: lines.length };
		},
		write: async ({ path, content }) => {
			const file = virtualPath(path);
			await mkdirp(fs, dirname(file));
			await fs.writeFile(file, content);
			return { path, bytes: Buffer.byteLength(content) };
		},
		edit: async ({ path, oldText, newText, replaceAll }) => {
			const file = virtualPath(path);
			const text = await fs.readFile(file);
			const count = text.split(oldText).length - 1;
			if (count === 0) throw new Error(`text not found in ${path}`);
			if (!replaceAll && count > 1) throw new Error(`text is not unique in ${path}`);
			await fs.writeFile(file, replaceAll ? text.replaceAll(oldText, newText) : text.replace(oldText, newText));
			return { path, replacements: replaceAll ? count : 1 };
		},
		grep: async ({ query, path = ".", maxResults = 100 }) => {
			const hits: GrepHit[] = [];
			for (const file of await files(fs, virtualPath(path))) {
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
		find: async ({ pattern, path = ".", maxResults = 1000 }) => {
			const out: string[] = [];
			for (const file of await paths(fs, virtualPath(path))) {
				const rel = trim(file);
				if (!match(rel, pattern)) continue;
				out.push(rel);
				if (out.length >= maxResults) break;
			}
			return { paths: out };
		},
		ls: async ({ path = "." }) => {
			const base = virtualPath(path);
			const entries: LsEntry[] = [];
			for (const name of await fs.readdir(base)) {
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

async function mkdirp(fs: IFileSystem, path: string): Promise<void> {
	if (!path || path === "/" || (await fs.exists(path))) return;
	await mkdirp(fs, dirname(path));
	await fs.mkdir(path).catch(() => undefined);
}

async function paths(fs: IFileSystem, start: string): Promise<string[]> {
	const info = await fs.stat(start);
	if (info.isFile) return [start];
	const out: string[] = [start];
	for (const name of await fs.readdir(start))
		out.push(...(await paths(fs, start === "/" ? `/${name}` : `${start}/${name}`)));
	return out.filter((path) => path !== "/");
}

async function files(fs: IFileSystem, start: string): Promise<string[]> {
	const all = await paths(fs, start);
	const out: string[] = [];
	for (const path of all) if ((await fs.stat(path)).isFile) out.push(path);
	return out;
}

function trim(path: string): string {
	return path.replace(/^\//, "");
}
