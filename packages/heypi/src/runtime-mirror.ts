import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { join, posix, relative, sep } from "node:path";
import type { RuntimeRoots } from "./runtime-path.js";
import type { RuntimeFileSystem } from "./runtime-provider.js";

function pairs(roots: RuntimeRoots): Array<{ guest: string; host: string }> {
	return [
		{ guest: "/workspace", host: roots.workspace },
		...(roots.shared ? [{ guest: "/shared", host: roots.shared }] : []),
	];
}

async function uploadDirectory(fs: RuntimeFileSystem, host: string, guest: string): Promise<void> {
	await fs.mkdir(guest);
	for (const entry of await readdir(host, { withFileTypes: true })) {
		const hostPath = join(host, entry.name);
		const guestPath = posix.join(guest, entry.name);
		if (entry.isDirectory()) await uploadDirectory(fs, hostPath, guestPath);
		else if (entry.isFile()) await fs.writeFile(guestPath, await readFile(hostPath));
	}
}

async function downloadDirectory(fs: RuntimeFileSystem, guest: string, host: string): Promise<void> {
	await mkdir(host, { recursive: true });
	for (const name of await fs.readdir(guest)) {
		const guestPath = posix.join(guest, name);
		const hostPath = join(host, name);
		if ((await fs.stat(guestPath)).isDirectory()) await downloadDirectory(fs, guestPath, hostPath);
		else await writeFile(hostPath, await fs.readFile(guestPath));
	}
}

/** Upload the durable host roots into a newly created remote sandbox. */
export async function uploadRuntimeRoots(fs: RuntimeFileSystem, roots: RuntimeRoots): Promise<void> {
	for (const root of pairs(roots)) await uploadDirectory(fs, root.host, root.guest);
}

/** Materialize remote files into the durable host roots without deleting unrelated host files. */
export async function downloadRuntimeRoots(fs: RuntimeFileSystem, roots: RuntimeRoots): Promise<void> {
	for (const root of pairs(roots)) await downloadDirectory(fs, root.guest, root.host);
}

/** Mirror direct file-tool writes immediately so chat attachments can read them from the host. */
export function mirrorRuntimeFileSystem(fs: RuntimeFileSystem, roots: RuntimeRoots): RuntimeFileSystem {
	function hostPath(path: string): string {
		const root = pairs(roots).find(({ guest }) => path === guest || path.startsWith(`${guest}/`));
		if (!root) throw new Error(`path escapes runtime workspace: ${path}`);
		return join(root.host, relative(root.guest, path).split(sep).join("/"));
	}

	return {
		...fs,
		async mkdir(path) {
			await Promise.all([fs.mkdir(path), mkdir(hostPath(path), { recursive: true })]);
		},
		async writeFile(path, content) {
			await Promise.all([fs.writeFile(path, content), writeFile(hostPath(path), content)]);
		},
	};
}
