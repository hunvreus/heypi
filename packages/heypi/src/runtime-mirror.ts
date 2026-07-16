import {
	chmod,
	lstat,
	mkdir,
	readdir,
	readFile,
	readlink,
	realpath,
	rm,
	rmdir,
	symlink,
	writeFile,
} from "node:fs/promises";
import { dirname, isAbsolute, join, posix, relative, resolve, sep } from "node:path";
import type { RuntimeRoots } from "./runtime-path.js";
import type { RuntimeFileStat, RuntimeMirrorFileSystem } from "./runtime-provider.js";

type Kind = "directory" | "file" | "symlink" | "other";
type Entry = { kind: Kind; mode: number };

function pairs(roots: RuntimeRoots): Array<{ guest: string; host: string }> {
	return [
		{ guest: "/workspace", host: roots.workspace },
		...(roots.shared ? [{ guest: "/shared", host: roots.shared }] : []),
	];
}

function kind(stat: RuntimeFileStat): Kind {
	if (stat.isSymbolicLink?.()) return "symlink";
	if (stat.isDirectory()) return "directory";
	return stat.isFile?.() === true ? "file" : "other";
}

function mode(value: number | undefined): number {
	return (value ?? 0o644) & 0o777;
}

function inside(root: string, path: string): boolean {
	const rel = relative(root, path);
	return rel === "" || (rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel));
}

async function uploadLinkTarget(hostRoot: string, guestRoot: string, path: string): Promise<string> {
	const target = await readlink(path);
	const parent = await realpath(dirname(path));
	const lexical = isAbsolute(target) ? resolve(target) : resolve(parent, target);
	if (!inside(hostRoot, lexical)) throw new Error("symlink escapes runtime root");
	let resolved = lexical;
	try {
		resolved = await realpath(path);
	} catch (error) {
		const code = (error as NodeJS.ErrnoException).code;
		if (code !== "ENOENT" && code !== "ELOOP") throw error;
	}
	if (!inside(hostRoot, resolved)) throw new Error("symlink escapes runtime root");
	if (!isAbsolute(target)) return target;
	const rel = relative(hostRoot, resolved).split(sep).join("/");
	return rel ? posix.join(guestRoot, rel) : guestRoot;
}

function downloadLinkTarget(
	hostRoot: string,
	guestRoot: string,
	hostPath: string,
	guestPath: string,
	target: string,
): string {
	const resolved = posix.isAbsolute(target) ? posix.resolve(target) : posix.resolve(posix.dirname(guestPath), target);
	if (resolved !== guestRoot && !resolved.startsWith(`${guestRoot}/`)) {
		throw new Error(`symlink escapes runtime root: ${guestPath}`);
	}
	if (!posix.isAbsolute(target)) return target;
	const targetHost = join(hostRoot, posix.relative(guestRoot, resolved));
	return relative(dirname(hostPath), targetHost) || ".";
}

async function remoteKind(fs: RuntimeMirrorFileSystem, path: string): Promise<Kind | undefined> {
	try {
		return kind(await fs.lstat(path));
	} catch {
		return undefined;
	}
}

async function ensureRemote(fs: RuntimeMirrorFileSystem, path: string, expected: Kind): Promise<void> {
	const current = await remoteKind(fs, path);
	if (current === expected) return;
	if (current) await fs.rm(path);
	if (expected === "directory") await fs.mkdir(path);
}

async function uploadDirectory(
	fs: RuntimeMirrorFileSystem,
	hostRoot: string,
	guestRoot: string,
	host: string,
	guest: string,
	snapshot: Map<string, Entry>,
	base = "",
): Promise<void> {
	await ensureRemote(fs, guest, "directory");
	for (const name of await readdir(host)) {
		const hostPath = join(host, name);
		const guestPath = posix.join(guest, name);
		const entryPath = base ? posix.join(base, name) : name;
		const stat = await lstat(hostPath);
		const entryKind = stat.isSymbolicLink() ? "symlink" : stat.isDirectory() ? "directory" : "file";
		if (!stat.isSymbolicLink() && !stat.isDirectory() && !stat.isFile()) {
			throw new Error(`unsupported runtime entry: ${guestPath}`);
		}
		snapshot.set(entryPath, { kind: entryKind, mode: mode(stat.mode) });
		if (entryKind === "directory") {
			await ensureRemote(fs, guestPath, entryKind);
			await uploadDirectory(fs, hostRoot, guestRoot, hostPath, guestPath, snapshot, entryPath);
			await fs.chmod(guestPath, mode(stat.mode));
		} else if (entryKind === "symlink") {
			const target = await uploadLinkTarget(hostRoot, guestRoot, hostPath);
			if (await remoteKind(fs, guestPath)) await fs.rm(guestPath);
			await fs.symlink(target, guestPath);
		} else {
			await ensureRemote(fs, guestPath, entryKind);
			await fs.writeFile(guestPath, await readFile(hostPath));
			await fs.chmod(guestPath, mode(stat.mode));
		}
	}
}

async function ensureHost(path: string, expected: Kind): Promise<void> {
	let current: Kind | undefined;
	try {
		const stat = await lstat(path);
		current = stat.isSymbolicLink() ? "symlink" : stat.isDirectory() ? "directory" : "file";
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
	}
	if (current === expected) return;
	if (current) await rm(path, { recursive: current === "directory", force: true });
	if (expected === "directory") await mkdir(path, { recursive: true });
}

async function downloadDirectory(
	fs: RuntimeMirrorFileSystem,
	hostRoot: string,
	guestRoot: string,
	guest: string,
	host: string,
	snapshot: Map<string, Entry>,
	base = "",
): Promise<void> {
	await mkdir(host, { recursive: true });
	for (const name of await fs.readdir(guest)) {
		const guestPath = posix.join(guest, name);
		const hostPath = join(host, name);
		const entryPath = base ? posix.join(base, name) : name;
		const stat = await fs.lstat(guestPath);
		const entryKind = kind(stat);
		if (entryKind === "other") throw new Error(`unsupported runtime entry: ${guestPath}`);
		snapshot.set(entryPath, { kind: entryKind, mode: mode(stat.mode) });
		if (entryKind === "directory") {
			await ensureHost(hostPath, entryKind);
			await downloadDirectory(fs, hostRoot, guestRoot, guestPath, hostPath, snapshot, entryPath);
			await chmod(hostPath, mode(stat.mode));
		} else if (entryKind === "symlink") {
			const target = downloadLinkTarget(hostRoot, guestRoot, hostPath, guestPath, await fs.readlink(guestPath));
			await ensureHost(hostPath, entryKind);
			await rm(hostPath, { force: true });
			await symlink(target, hostPath);
		} else {
			await ensureHost(hostPath, entryKind);
			await mkdir(dirname(hostPath), { recursive: true });
			await writeFile(hostPath, await fs.readFile(guestPath));
			await chmod(hostPath, mode(stat.mode));
		}
	}
}

async function removeDeleted(host: string, previous: Map<string, Entry>, current: Map<string, Entry>): Promise<void> {
	const deleted = [...previous.entries()]
		.filter(([path]) => !current.has(path))
		.sort(([left], [right]) => right.split("/").length - left.split("/").length);
	for (const [path, entry] of deleted) {
		const target = join(host, path);
		try {
			const stat = await lstat(target);
			const hostKind = stat.isSymbolicLink() ? "symlink" : stat.isDirectory() ? "directory" : "file";
			if (hostKind !== entry.kind) continue;
			if (entry.kind === "directory") await rmdir(target);
			else await rm(target, { force: true });
		} catch (error) {
			const code = (error as NodeJS.ErrnoException).code;
			if (code !== "ENOENT" && code !== "ENOTEMPTY") throw error;
		}
	}
}

export type RuntimeMirror = {
	fs: RuntimeMirrorFileSystem;
	upload(): Promise<void>;
	download(): Promise<void>;
	downloadAfter<T>(operation: () => Promise<T>): Promise<T>;
};

/** Keep durable host roots and a remote sandbox filesystem synchronized. */
export function createRuntimeMirror(remote: RuntimeMirrorFileSystem, roots: RuntimeRoots): RuntimeMirror {
	const snapshots = new Map<string, Map<string, Entry>>();

	async function upload(): Promise<void> {
		for (const root of pairs(roots)) {
			const previous = snapshots.get(root.guest) ?? new Map();
			const snapshot = new Map<string, Entry>();
			await uploadDirectory(remote, await realpath(root.host), root.guest, root.host, root.guest, snapshot);
			for (const path of previous.keys()) {
				if (!snapshot.has(path)) await remote.rm(posix.join(root.guest, path));
			}
			snapshots.set(root.guest, snapshot);
		}
	}

	async function download(): Promise<void> {
		for (const root of pairs(roots)) {
			const snapshot = new Map<string, Entry>();
			await downloadDirectory(remote, root.host, root.guest, root.guest, root.host, snapshot);
			await removeDeleted(root.host, snapshots.get(root.guest) ?? new Map(), snapshot);
			snapshots.set(root.guest, snapshot);
		}
	}

	async function downloadAfter<T>(operation: () => Promise<T>): Promise<T> {
		let result: T;
		try {
			result = await operation();
		} catch (error) {
			try {
				await download();
			} catch (syncError) {
				throw new AggregateError([error, syncError], "Runtime operation and mirror download failed", {
					cause: error,
				});
			}
			throw error;
		}
		await download();
		return result;
	}

	function rootFor(path: string): { guest: string; host: string } {
		const root = pairs(roots).find(({ guest }) => path === guest || path.startsWith(`${guest}/`));
		if (!root) throw new Error(`path escapes runtime workspace: ${path}`);
		return root;
	}

	function hostPath(path: string): string {
		const root = rootFor(path);
		return join(root.host, relative(root.guest, path).split(sep).join("/"));
	}

	function record(path: string, entry: Entry, parents = false): void {
		const root = rootFor(path);
		const snapshot = snapshots.get(root.guest) ?? new Map<string, Entry>();
		const relativePath = posix.relative(root.guest, path);
		if (parents) {
			let parent = "";
			for (const segment of relativePath.split("/").filter(Boolean)) {
				parent = parent ? posix.join(parent, segment) : segment;
				if (!snapshot.has(parent)) snapshot.set(parent, { kind: "directory", mode: 0o755 });
			}
		}
		if (relativePath) snapshot.set(relativePath, entry);
		snapshots.set(root.guest, snapshot);
	}

	return {
		upload,
		download,
		downloadAfter,
		fs: {
			...remote,
			async mkdir(path) {
				await Promise.all([remote.mkdir(path), mkdir(hostPath(path), { recursive: true })]);
				const stat = await remote.lstat(path);
				record(path, { kind: kind(stat), mode: mode(stat.mode) }, true);
			},
			async writeFile(path, content) {
				await Promise.all([remote.writeFile(path, content), writeFile(hostPath(path), content)]);
				const stat = await remote.lstat(path);
				record(path, { kind: kind(stat), mode: mode(stat.mode) });
			},
		},
	};
}
