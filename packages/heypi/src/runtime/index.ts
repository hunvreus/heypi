import { resolve } from "node:path";
import type { RuntimeConfig } from "../config.js";
import { hostBash } from "./host-bash.js";
import { justBash } from "./just-bash.js";
import { safeRoot } from "./path.js";
import type { Runtime, RuntimeName, RuntimeScope } from "./types.js";

export function runtimeName(input?: string): RuntimeName {
	const value = (input ?? "just-bash").trim().toLowerCase();
	if (value === "just-bash" || value === "guarded-bash" || value === "host-bash") return value;
	throw new Error(`unknown runtime: ${value}`);
}

export function createRuntime(
	input: RuntimeConfig & { app: string; agent?: string; runtimeScope?: RuntimeScope },
): Runtime {
	const root = safeRoot({ root: input.root, app: input.app, agent: input.agent });
	if (input.provider) {
		return input.provider.get({ ...(input.runtimeScope ?? { key: "app", path: "app" }), root });
	}
	const name = runtimeName(input.name);
	if (name === "just-bash")
		return justBash({ root, timeoutMs: input.timeoutMs, options: input.justBash, limits: input.limits });
	return hostBash({
		root,
		guarded: name === "guarded-bash",
		timeoutMs: input.timeoutMs,
		env: input.hostEnv,
		limits: input.limits,
	});
}

export function workspace(path = "./workspace"): string {
	return resolve(path);
}
