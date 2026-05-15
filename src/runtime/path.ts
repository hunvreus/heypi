import { relative, resolve } from "node:path";

export function inside(root: string, path: string): boolean {
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

export function hostPath(root: string, path = "."): string {
	const full = resolve(root, path.replace(/^\/+/, ""));
	if (!inside(root, full)) throw new Error(`path escapes runtime root: ${path}`);
	return full;
}

export function virtualPath(path = "."): string {
	const value = path.trim() || ".";
	if (value === ".") return "/";
	return value.startsWith("/") ? value : `/${value}`;
}
