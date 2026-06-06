export type GateResult = { ok: true } | { ok: false; reason: string };

export type GateDimension = {
	allowlist?: string[];
	value?: string;
	reason: string;
	skip?: boolean;
};

export function allowByDimensions(input: {
	dms?: boolean;
	isDm: boolean;
	dmReason: string;
	dimensions: GateDimension[];
}): GateResult {
	if (input.isDm && input.dms === false) return { ok: false, reason: input.dmReason };
	for (const dimension of input.dimensions) {
		if (dimension.skip) continue;
		if (!included(dimension.allowlist, dimension.value)) return { ok: false, reason: dimension.reason };
	}
	return { ok: true };
}

export function messageTriggered(input: {
	trigger?: "mention" | "message";
	isDm: boolean;
	thread?: boolean;
	threadTrigger?: "mention" | "message" | false;
	mentioned: boolean;
	text?: string;
	reason: string;
}): GateResult {
	if (input.isDm) return { ok: true };
	if (controlCommand(input.text)) return { ok: true };
	if ((input.trigger ?? "mention") === "message") return { ok: true };
	if (input.thread && (input.threadTrigger ?? "message") === "message") return { ok: true };
	if (input.mentioned) return { ok: true };
	return { ok: false, reason: input.reason };
}

function included(allowlist: string[] | undefined, value: string | undefined): boolean {
	return !allowlist?.length || (value !== undefined && allowlist.includes(value));
}

function controlCommand(input?: string): boolean {
	const text = input?.replace(/<@[^>]+>/g, "").trim();
	return Boolean(
		text && /^\/(approvals|approve\s+\S+|deny\s+\S+|cancel\s+\S+|status(?:\s+\S+)?|help|bash(?:\s+.+)?)$/i.test(text),
	);
}
