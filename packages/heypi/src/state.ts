import { resolve } from "node:path";

export type StateConfig = {
	root: string;
};

export function normalizeStateRoot(config: StateConfig | undefined, cwd = process.cwd()): string {
	const root = config?.root?.trim();
	if (!root) throw new Error('state.root is required; set state: { root: "./state" }');
	return resolve(cwd, root);
}
