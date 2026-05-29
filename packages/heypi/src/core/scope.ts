import { join } from "node:path";
import type { RuntimeConfig, Scope } from "../config.js";
import { createRuntime } from "../runtime/index.js";
import type { Runtime } from "../runtime/types.js";

export type ScopedKey = {
	level: Scope;
	key: string;
	path: string;
};

export type ScopeInput = {
	agent: string;
	provider: string;
	kind: string;
	team?: string;
	channel: string;
	actor: string;
};

export type ScopeKeys = {
	agent: ScopedKey;
	adapter: ScopedKey;
	channel: ScopedKey;
	user: ScopedKey;
};

export type TurnScope = {
	workspace: ScopedKey;
	memory: ScopedKey;
	keys: ScopeKeys;
};

export function resolveScope(input: ScopeInput): ScopeKeys {
	const agent = ["agent", input.agent];
	const adapter = ["adapter", input.agent, input.provider];
	const channel = ["channel", input.agent, input.provider, input.team ?? "none", input.channel];
	const user = ["user", input.agent, input.provider, input.team ?? "none", input.actor];
	return {
		agent: scoped("agent", agent),
		adapter: scoped("adapter", adapter),
		channel: scoped("channel", channel),
		user: scoped("user", user),
	};
}

export function selectScope(keys: ScopeKeys, level: Scope | undefined): ScopedKey {
	return keys[level ?? "channel"];
}

export class ScopedRuntimeRegistry {
	private readonly cache = new Map<string, Runtime>();

	constructor(
		private readonly config: RuntimeConfig,
		private readonly input: { app: string; agent?: string },
	) {}

	get(scope: ScopedKey): Runtime {
		return this.getPath(scope.path, scope);
	}

	getPath(path = "agent/default", scope?: Pick<ScopedKey, "level" | "key">): Runtime {
		const cached = this.cache.get(path);
		if (cached) return cached;
		const root = join(this.config.root, "scopes", path);
		const runtime = createRuntime({
			...this.config,
			root,
			app: this.input.app,
			agent: this.input.agent,
			runtimeScope: { level: scope?.level, key: scope?.key ?? path, path, root },
		});
		this.cache.set(path, runtime);
		return runtime;
	}

	async close(): Promise<void> {
		await this.config.provider?.close?.();
	}
}

function scoped(level: Scope, segments: string[]): ScopedKey {
	const path = join(...segments.map(segment));
	return { level, key: segments.join("/"), path };
}

function segment(value: string): string {
	// Use ~ as a readable, path-safe stand-in for percent escapes.
	return encodeURIComponent(value).replaceAll("%", "~");
}
