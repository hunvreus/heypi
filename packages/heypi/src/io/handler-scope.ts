import type { Scope } from "../config.js";
import type { TurnScope } from "../core/scope.js";
import { resolveScope, selectScope } from "../core/scope.js";

export type ScopeInput = {
	agent: string;
	provider: string;
	kind?: string;
	team?: string;
	channel: string;
	actor: string;
	scope?: Scope;
	runtimeScope?: Scope;
	memoryScope?: Scope;
	skillsScope?: Scope;
};

export function resolveTurnScope(input: ScopeInput): TurnScope {
	const keys = resolveScope({
		agent: input.agent,
		provider: input.provider,
		kind: input.kind ?? input.provider,
		team: input.team,
		channel: input.channel,
		actor: input.actor,
	});
	return {
		workspace: selectScope(keys, input.runtimeScope ?? input.scope),
		memory: selectScope(keys, input.memoryScope ?? input.scope),
		skills: selectScope(keys, input.skillsScope ?? input.scope),
		keys,
	};
}

export function channelKey(msg: Pick<ScopeInput, "provider" | "team" | "channel">): string {
	return `${msg.provider}:${msg.team ?? ""}:${msg.channel}`;
}
