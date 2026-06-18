export type ControlActionKind = "approve" | "deny" | "cancel" | "status";

export type ControlAction =
	| { kind: Exclude<ControlActionKind, "status">; id: string }
	| { kind: "status"; id?: string };

export type ControlActionTokens = Record<ControlActionKind, string>;

export function parseControlAction(input: string | undefined, tokens: ControlActionTokens): ControlAction | undefined {
	if (!input) return undefined;
	if (input === tokens.status) return { kind: "status" };
	const index = input.indexOf(":");
	if (index <= 0) return undefined;
	const token = input.slice(0, index);
	const id = input.slice(index + 1);
	if (!id) return undefined;
	const kind = controlActionKind(token, tokens);
	if (!kind) return undefined;
	if (kind === "status") return { kind, id };
	return { kind, id };
}

export function controlActionText(action: ControlAction): string {
	if (action.kind === "status") return action.id ? `/status ${action.id}` : "/status";
	return `/${action.kind} ${action.id}`;
}

function controlActionKind(input: string, tokens: ControlActionTokens): ControlActionKind | undefined {
	if (input === tokens.approve) return "approve";
	if (input === tokens.deny) return "deny";
	if (input === tokens.cancel) return "cancel";
	if (input === tokens.status) return "status";
	return undefined;
}
