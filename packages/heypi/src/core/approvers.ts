export type ActorPolicy =
	| string[]
	| {
			users?: string[];
			groups?: string[];
	  };

export type ActorIdentity = {
	actor: string;
	groups?: string[];
};

export function actorUsers(input: ActorPolicy | undefined): string[] {
	if (Array.isArray(input)) return input;
	return input?.users ?? [];
}

export function actorGroups(input: ActorPolicy | undefined): string[] {
	return Array.isArray(input) ? [] : (input?.groups ?? []);
}

export function actorLabels(input: ActorPolicy | undefined): string[] {
	return [...actorUsers(input), ...actorGroups(input)];
}

export function hasActorPolicy(input: ActorPolicy | undefined): boolean {
	return actorUsers(input).length > 0 || actorGroups(input).length > 0;
}

export function actorAllowed(policy: ActorPolicy | undefined, identity: ActorIdentity): boolean {
	const users = actorUsers(policy);
	const groups = actorGroups(policy);
	if (users.length === 0 && groups.length === 0) return true;
	if (users.includes(identity.actor)) return true;
	return groups.some((group) => identity.groups?.includes(group));
}
