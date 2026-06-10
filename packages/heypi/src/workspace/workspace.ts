import type { Stats } from "node:fs";
import { lstat, mkdir, readdir, readFile, realpath, rm, stat, writeFile } from "node:fs/promises";
import { dirname, relative, resolve, sep } from "node:path";
import { pathToFileURL } from "node:url";

export type WorkspaceEntry = {
	path: string;
	type: "file" | "directory" | "other";
	size?: number;
	mtimeMs?: number;
};

export type Workspace = {
	read(path: string): Promise<Uint8Array | undefined>;
	write(path: string, data: Uint8Array): Promise<void>;
	stat(path: string): Promise<WorkspaceEntry | undefined>;
	/** Recursively lists entries under a relative POSIX prefix. */
	list(prefix: string): Promise<WorkspaceEntry[]>;
	delete(path: string): Promise<void>;
};

export function localWorkspace(root: string): Workspace {
	const base = resolve(root);
	return {
		async read(path) {
			const full = await existingPath(base, path);
			if (!full) return undefined;
			const info = await stat(full);
			if (!info.isFile()) return undefined;
			return await readFile(full);
		},
		async write(path, data) {
			const safe = workspacePath(path);
			const full = resolve(base, safe);
			const parent = dirname(full);
			await mkdirpInside(base, parent);
			await assertWritableInside(base, full, path);
			await writeFile(full, data);
		},
		async stat(path) {
			const safe = workspacePath(path);
			const full = await existingPath(base, safe);
			if (!full) return undefined;
			return entry(safe, await stat(full));
		},
		async list(prefix) {
			const safe = workspacePath(prefix);
			const full = await existingPath(base, safe);
			if (!full) return [];
			const info = await stat(full);
			if (!info.isDirectory()) return [entry(safe, info)];
			return await listRecursive(full, safe);
		},
		async delete(path) {
			const full = await existingPath(base, path);
			if (!full) return;
			await rm(full, { recursive: true, force: true });
		},
	};
}

export function workspacePath(input: string): string {
	if (input.includes("\0")) throw new Error("workspace path contains a null byte");
	if (input.startsWith("/") || /^[a-zA-Z]:[\\/]/u.test(input))
		throw new Error(`workspace path must be relative: ${input}`);
	if (input.includes("\\")) throw new Error("workspace path must use forward slashes");
	const normalized = input.split("/").filter((part) => part && part !== ".");
	if (normalized.some((part) => part === "..")) {
		throw new Error(`workspace path escapes root: ${input}`);
	}
	return normalized.join("/");
}

function inside(root: string, path: string): boolean {
	const rel = relative(resolve(root), resolve(path));
	return rel === "" || (!rel.startsWith("..") && !rel.startsWith("/") && !rel.match(/^[a-zA-Z]:/u));
}

async function existingPath(root: string, path: string): Promise<string | undefined> {
	const safe = workspacePath(path);
	const full = resolve(root, safe);
	if (!inside(root, full)) throw new Error(`workspace path escapes root: ${path}`);
	const realRoot = await ensureRoot(root);
	const realFull = await realpath(full).catch((error: unknown) => {
		if (enoent(error)) return undefined;
		throw error;
	});
	if (!realFull) return undefined;
	if (!inside(realRoot, realFull)) throw new Error(`workspace path escapes root: ${path}`);
	return realFull;
}

async function assertWritableInside(root: string, full: string, label: string): Promise<void> {
	const realRoot = await ensureRoot(root);
	const realParent = await realpath(dirname(full));
	if (!inside(realRoot, realParent)) throw new Error(`workspace path escapes root: ${label}`);
	const info = await lstat(full).catch((error: unknown) => {
		if (enoent(error)) return undefined;
		throw error;
	});
	if (info?.isSymbolicLink()) throw new Error(`workspace path escapes root: ${label}`);
}

async function mkdirpInside(root: string, path: string): Promise<void> {
	const realRoot = await ensureRoot(root);
	const rel = relative(resolve(root), resolve(path));
	const parts = rel.split(sep).filter(Boolean);
	let current = resolve(root);
	for (const part of parts) {
		current = resolve(current, part);
		if (!inside(root, current)) throw new Error(`workspace path escapes root: ${pathToFileURL(path).pathname}`);
		const info = await lstat(current).catch((error: unknown) => {
			if (enoent(error)) return undefined;
			throw error;
		});
		if (info?.isSymbolicLink()) throw new Error(`workspace path escapes root: ${pathToFileURL(path).pathname}`);
		if (info && !info.isDirectory())
			throw new Error(`workspace path is not a directory: ${pathToFileURL(path).pathname}`);
		if (!info) await mkdir(current);
	}
	const realFull = await realpath(path);
	if (!inside(realRoot, realFull)) throw new Error(`workspace path escapes root: ${pathToFileURL(path).pathname}`);
}

async function ensureRoot(root: string): Promise<string> {
	await mkdir(root, { recursive: true });
	return await realpath(root);
}

async function listRecursive(root: string, prefix: string): Promise<WorkspaceEntry[]> {
	const out: WorkspaceEntry[] = [];
	for (const item of await readdir(root, { withFileTypes: true })) {
		const full = resolve(root, item.name);
		const current = [prefix, item.name].filter(Boolean).join("/");
		const info = await stat(full);
		out.push(entry(current, info));
		if (item.isDirectory()) out.push(...(await listRecursive(full, current)));
	}
	return out.sort((a, b) => a.path.localeCompare(b.path));
}

function entry(path: string, info: Stats): WorkspaceEntry {
	return {
		path,
		type: info.isFile() ? "file" : info.isDirectory() ? "directory" : "other",
		size: info.size,
		mtimeMs: info.mtimeMs,
	};
}

function enoent(error: unknown): boolean {
	return Boolean(error && typeof error === "object" && "code" in error && error.code === "ENOENT");
}
