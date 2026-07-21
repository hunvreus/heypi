import { isAbsolute, posix, relative, resolve, sep } from "node:path";

export const GUEST_WORKSPACE = "/workspace";
export const GUEST_SHARED = "/shared";
export const GUEST_SKILLS = "/agent/skills";

export type RuntimeRoots = {
	workspace: string;
	shared?: string;
	skills?: string;
};

function inside(root: string, path: string): boolean {
	const rel = relative(root, path);
	return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

export function assertInside(root: string, path: string): void {
	if (!inside(root, path)) throw new Error("path escapes runtime workspace");
}

export function assertGuestPath(path: string): string {
	const normalized = posix.normalize(path);
	if (
		normalized !== GUEST_WORKSPACE &&
		!normalized.startsWith(`${GUEST_WORKSPACE}/`) &&
		normalized !== GUEST_SHARED &&
		!normalized.startsWith(`${GUEST_SHARED}/`) &&
		normalized !== GUEST_SKILLS &&
		!normalized.startsWith(`${GUEST_SKILLS}/`)
	) {
		throw new Error(`path escapes runtime workspace: ${path}`);
	}
	return normalized;
}

function rootForGuestPath(roots: RuntimeRoots, inputPath: string): { guest: string; host: string } | undefined {
	if (inputPath === GUEST_WORKSPACE || inputPath.startsWith(`${GUEST_WORKSPACE}/`)) {
		return { guest: GUEST_WORKSPACE, host: roots.workspace };
	}
	if (roots.shared && (inputPath === GUEST_SHARED || inputPath.startsWith(`${GUEST_SHARED}/`))) {
		return { guest: GUEST_SHARED, host: roots.shared };
	}
	if (roots.skills && (inputPath === GUEST_SKILLS || inputPath.startsWith(`${GUEST_SKILLS}/`))) {
		return { guest: GUEST_SKILLS, host: roots.skills };
	}
	return undefined;
}

export function assertWritableGuestPath(roots: RuntimeRoots, inputPath: string): string {
	const path = guestPath(roots, inputPath);
	if (path === GUEST_SKILLS || path.startsWith(`${GUEST_SKILLS}/`)) {
		throw new Error(`path is read-only: ${path}`);
	}
	return path;
}

export function guestPath(roots: RuntimeRoots, inputPath: string): string {
	const guestRoot = rootForGuestPath(roots, inputPath);
	if (guestRoot) return assertGuestPath(inputPath);
	const resolved = isAbsolute(inputPath) ? resolve(inputPath) : resolve(roots.workspace, inputPath);
	assertInside(roots.workspace, resolved);
	const rel = relative(roots.workspace, resolved).split(sep).join("/");
	return rel ? `${GUEST_WORKSPACE}/${rel}` : GUEST_WORKSPACE;
}

export function hostPath(roots: RuntimeRoots, inputPath: string): string {
	const guestRoot = rootForGuestPath(roots, inputPath);
	if (guestRoot) {
		const rel = posix.relative(guestRoot.guest, posix.normalize(inputPath));
		const resolved = resolve(guestRoot.host, rel);
		assertInside(guestRoot.host, resolved);
		return resolved;
	}
	const resolved = isAbsolute(inputPath) ? resolve(inputPath) : resolve(roots.workspace, inputPath);
	assertInside(roots.workspace, resolved);
	return resolved;
}
