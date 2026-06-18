export type BotAllowList = true | readonly unknown[] | undefined;

export function botAllowConfigured(input: BotAllowList): boolean {
	return input === true || (Array.isArray(input) && input.length > 0);
}

export function botIdentityAllowed(input: {
	allow: BotAllowList;
	botIds: Array<string | number | undefined>;
	selfIds: Array<string | number | undefined>;
}): boolean {
	const botIds = normalizedIds(input.botIds);
	const selfIds = normalizedIds(input.selfIds);
	if (!selfIds.length) return false;
	if (botIds.some((id) => selfIds.includes(id))) return false;
	if (input.allow === true) return true;
	if (!Array.isArray(input.allow) || input.allow.length === 0) return false;
	const allowed = normalizedIds(input.allow);
	return botIds.some((id) => allowed.includes(id));
}

function normalizedIds(input: readonly unknown[]): string[] {
	return input
		.map((id) => (id === undefined || id === null ? undefined : String(id)))
		.filter((id): id is string => Boolean(id));
}
