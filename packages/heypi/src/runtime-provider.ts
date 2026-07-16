import { posix } from "node:path";
import {
	type BashOperations,
	createBashToolDefinition,
	createEditToolDefinition,
	createFindToolDefinition,
	createGrepToolDefinition,
	createLsToolDefinition,
	createReadToolDefinition,
	createWriteToolDefinition,
	DEFAULT_MAX_BYTES,
	type FindOperations,
	type GrepToolDetails,
	type GrepToolInput,
	type ToolDefinition,
	truncateHead,
	truncateLine,
} from "@earendil-works/pi-coding-agent";
import { GUEST_WORKSPACE, guestPath, type RuntimeRoots } from "./runtime-path.js";
import { globPattern } from "./runtime-util.js";

export type RuntimeFileSystem = {
	access(path: string): Promise<void>;
	mkdir(path: string): Promise<void>;
	readFile(path: string): Promise<Buffer | Uint8Array | string>;
	readdir(path: string): Promise<string[]>;
	stat(path: string): Promise<RuntimeFileStat>;
	writeFile(path: string, content: string | Uint8Array): Promise<void>;
};

export type RuntimeFileStat = {
	isDirectory(): boolean;
	isFile?(): boolean;
	isSymbolicLink?(): boolean;
	mode?: number;
};

export type RuntimeMirrorFileSystem = RuntimeFileSystem & {
	chmod(path: string, mode: number): Promise<void>;
	lstat(path: string): Promise<RuntimeFileStat & { isFile(): boolean }>;
	readlink(path: string): Promise<string>;
	rm(path: string): Promise<void>;
	symlink(target: string, path: string): Promise<void>;
};

export type RuntimeToolOptions = {
	fs: RuntimeFileSystem;
	bash: BashOperations;
	find?: FindOperations;
	roots: RuntimeRoots;
};

function buffer(value: Buffer | Uint8Array | string): Buffer {
	return Buffer.isBuffer(value) ? value : Buffer.from(value);
}

function ignored(path: string, patterns: string[]): boolean {
	return patterns.some((pattern) => {
		const segment = pattern.replace(/^\*\*\//, "").replace(/\/\*\*$/, "");
		return segment && path.split("/").includes(segment);
	});
}

async function findFiles(
	fs: RuntimeFileSystem,
	root: string,
	pattern: string,
	options: { ignore: string[]; limit: number },
): Promise<string[]> {
	const matcher = globPattern(pattern.includes("/") ? pattern : `**/${pattern}`);
	const files: string[] = [];

	async function visit(directory: string, relative = ""): Promise<void> {
		for (const name of await fs.readdir(directory)) {
			if (files.length >= options.limit) return;
			const childRelative = relative ? posix.join(relative, name) : name;
			if (ignored(childRelative, options.ignore)) continue;
			const child = posix.join(directory, name);
			const entry = await fs.stat(child);
			if (entry.isDirectory()) await visit(child, childRelative);
			else if (matcher.test(childRelative)) files.push(child);
		}
	}

	await visit(root);
	return files;
}

function lineMatcher(pattern: string, literal?: boolean, ignoreCase?: boolean): (line: string) => boolean {
	if (!literal) {
		const expression = new RegExp(pattern, ignoreCase ? "i" : undefined);
		return (line) => expression.test(line);
	}
	const expected = ignoreCase ? pattern.toLowerCase() : pattern;
	return (line) => (ignoreCase ? line.toLowerCase() : line).includes(expected);
}

function createRuntimeGrep(fs: RuntimeFileSystem, roots: RuntimeRoots) {
	const base = createGrepToolDefinition(GUEST_WORKSPACE);
	const execute: typeof base.execute = async (_id, input: GrepToolInput, signal) => {
		const root = guestPath(roots, input.path ?? ".");
		const rootStat = await fs.stat(root).catch(() => undefined);
		if (!rootStat) throw new Error(`Path not found: ${root}`);
		const rootDirectory = rootStat.isDirectory();
		const matches = lineMatcher(input.pattern, input.literal, input.ignoreCase);
		const filePattern = input.glob
			? globPattern(input.glob.includes("/") ? input.glob : `**/${input.glob}`)
			: undefined;
		const context = Math.max(0, input.context ?? 0);
		const limit = Math.max(1, input.limit ?? 100);
		const output: string[] = [];
		let count = 0;
		let linesTruncated = false;

		async function search(path: string, relative: string): Promise<void> {
			signal?.throwIfAborted();
			if (count >= limit || (filePattern && !filePattern.test(relative))) return;
			let content: string;
			try {
				content = buffer(await fs.readFile(path)).toString("utf8");
			} catch {
				return;
			}
			const lines = content.replace(/\r\n/g, "\n").replace(/\r/g, "\n").split("\n");
			for (let index = 0; index < lines.length && count < limit; index++) {
				if (!matches(lines[index] ?? "")) continue;
				count++;
				const start = context ? Math.max(0, index - context) : index;
				const end = context ? Math.min(lines.length - 1, index + context) : index;
				for (let current = start; current <= end; current++) {
					const truncated = truncateLine(lines[current] ?? "");
					linesTruncated ||= truncated.wasTruncated;
					output.push(
						`${relative}${current === index ? ":" : "-"}${current + 1}${current === index ? ":" : "-"} ${truncated.text}`,
					);
				}
			}
		}

		async function visit(directory: string, relative = ""): Promise<void> {
			for (const name of await fs.readdir(directory)) {
				if (count >= limit) return;
				if (name === ".git" || name === "node_modules") continue;
				const child = posix.join(directory, name);
				const childRelative = relative ? posix.join(relative, name) : name;
				if ((await fs.stat(child)).isDirectory()) await visit(child, childRelative);
				else await search(child, childRelative);
			}
		}

		if (rootDirectory) await visit(root);
		else await search(root, posix.basename(root));
		if (count === 0) return { content: [{ type: "text", text: "No matches found" }], details: undefined };
		const truncation = truncateHead(output.join("\n"), { maxLines: Number.MAX_SAFE_INTEGER });
		const details: GrepToolDetails = {};
		const notices: string[] = [];
		if (count >= limit) {
			details.matchLimitReached = limit;
			notices.push(`${limit} matches limit reached`);
		}
		if (truncation.truncated) {
			details.truncation = truncation;
			notices.push(`${DEFAULT_MAX_BYTES / 1024}KB limit reached`);
		}
		if (linesTruncated) {
			details.linesTruncated = true;
			notices.push("long lines truncated");
		}
		const text = notices.length ? `${truncation.content}\n\n[${notices.join(". ")}]` : truncation.content;
		return { content: [{ type: "text", text }], details: Object.keys(details).length ? details : undefined };
	};
	return { ...base, execute };
}

/** Build Pi's core tools over a sandbox filesystem and command backend. */
export function createRuntimeToolDefinitions(options: RuntimeToolOptions): ToolDefinition<any, any, any>[] {
	const resolve = (path: string) => guestPath(options.roots, path);
	const exists = async (path: string) => {
		const resolved = resolve(path);
		try {
			await options.fs.access(resolved);
			return true;
		} catch {
			return false;
		}
	};
	const read = {
		access: (path: string) => options.fs.access(resolve(path)),
		readFile: async (path: string) => buffer(await options.fs.readFile(resolve(path))),
	};
	const write = {
		mkdir: (path: string) => options.fs.mkdir(resolve(path)),
		writeFile: (path: string, content: string) => options.fs.writeFile(resolve(path), content),
	};

	return [
		createReadToolDefinition(GUEST_WORKSPACE, { operations: read }),
		createBashToolDefinition(GUEST_WORKSPACE, { operations: options.bash }),
		createEditToolDefinition(GUEST_WORKSPACE, { operations: { ...read, ...write } }),
		createWriteToolDefinition(GUEST_WORKSPACE, { operations: write }),
		createRuntimeGrep(options.fs, options.roots) as unknown as ToolDefinition<any, any, any>,
		createFindToolDefinition(GUEST_WORKSPACE, {
			operations: options.find ?? {
				exists,
				glob: (pattern, cwd, settings) => findFiles(options.fs, resolve(cwd), pattern, settings),
			},
		}),
		createLsToolDefinition(GUEST_WORKSPACE, {
			operations: {
				exists,
				stat: (path) => options.fs.stat(resolve(path)),
				readdir: (path) => options.fs.readdir(resolve(path)),
			},
		}),
	];
}
