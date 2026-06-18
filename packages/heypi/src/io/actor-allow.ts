import { type BotAllowList, botAllowConfigured } from "./bot-allow.js";

const ALLOWED = "allowed";

export type ActorAllow = {
	users?: readonly unknown[];
	groups?: readonly string[];
	bots?: BotAllowList;
};

export function actorAllowlist(allow: ActorAllow | undefined): string[] | undefined {
	if (!actorAllowConfigured(allow)) return undefined;
	return [ALLOWED];
}

export function actorAllowedValue(input: {
	allow: ActorAllow | undefined;
	user?: string;
	groups?: readonly string[];
	botAllowed?: boolean;
}): string | undefined {
	if (input.botAllowed !== undefined) return input.botAllowed ? ALLOWED : undefined;
	if (!input.allow?.users?.length && !input.allow?.groups?.length) return ALLOWED;
	if (input.user && ids(input.allow.users).includes(input.user)) return ALLOWED;
	if (input.allow.groups?.some((group) => input.groups?.includes(group))) return ALLOWED;
	return undefined;
}

function actorAllowConfigured(allow: ActorAllow | undefined): boolean {
	return Boolean(allow?.users?.length || allow?.groups?.length || botAllowConfigured(allow?.bots));
}

function ids(input: readonly unknown[] | undefined): string[] {
	return input?.map(String) ?? [];
}
