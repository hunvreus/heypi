import { lstat, mkdir, realpath } from "node:fs/promises";
import { dirname, relative, resolve, sep } from "node:path";

function inside(root: string, path: string): boolean {
	const rel = relative(resolve(root), resolve(path));
	return rel === "" || (!rel.startsWith("..") && !rel.startsWith("/"));
}

export function safeRoot(input: { root: string; app: string; agent?: string }): string {
	const root = resolve(input.root);
	const app = resolve(input.app);
	if (root === app || inside(root, app)) throw new Error(`runtime root contains app directory: ${root}`);
	if (input.agent) {
		const agent = resolve(input.agent);
		if (root === agent || inside(root, agent) || inside(agent, root)) {
			throw new Error(`runtime root overlaps agent directory: ${root}`);
		}
	}
	return root;
}

function hostPath(root: string, path = "."): string {
	const full = resolve(root, path.replace(/^\/+/, ""));
	if (!inside(root, full)) throw new Error(`path escapes runtime root: ${path}`);
	return full;
}

export async function hostRealPath(root: string, path = "."): Promise<string> {
	const full = hostPath(root, path);
	return await realInside(root, full, path);
}

export async function realInside(root: string, full: string, label = full): Promise<string> {
	const realRoot = await realpath(root);
	const realFull = await realpath(full);
	if (!inside(realRoot, realFull)) throw new Error(`path escapes runtime root: ${label}`);
	return realFull;
}

export async function hostWritePath(root: string, path = "."): Promise<string> {
	const full = hostPath(root, path);
	const parent = dirname(full);
	const realRoot = await realpath(root);
	const realParent = await realpath(parent);
	if (!inside(realRoot, realParent)) throw new Error(`path escapes runtime root: ${path}`);
	const info = await lstat(full).catch(() => undefined);
	if (info?.isSymbolicLink()) throw new Error(`path escapes runtime root: ${path}`);
	return full;
}

export async function hostMkdir(root: string, path = "."): Promise<string> {
	const full = hostPath(root, path);
	const realRoot = await realpath(root);
	const rel = relative(resolve(root), full);
	const parts = rel.split(sep).filter(Boolean);
	let current = resolve(root);
	for (const part of parts) {
		current = resolve(current, part);
		if (!inside(resolve(root), current)) throw new Error(`path escapes runtime root: ${path}`);
		const info = await lstat(current).catch(() => undefined);
		if (info?.isSymbolicLink()) throw new Error(`path escapes runtime root: ${path}`);
		if (info && !info.isDirectory()) throw new Error(`path is not a directory: ${path}`);
		if (!info) await mkdir(current);
	}
	const realFull = await realpath(full);
	if (!inside(realRoot, realFull)) throw new Error(`path escapes runtime root: ${path}`);
	return realFull;
}

export function virtualPath(path = "."): string {
	const value = path.trim() || ".";
	if (value === ".") return "/";
	return value.startsWith("/") ? value : `/${value}`;
}
