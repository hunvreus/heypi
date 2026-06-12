export type CommandName =
	| "help"
	| "bash"
	| "approvals"
	| "bypasses"
	| "approve"
	| "deny"
	| "cancel"
	| "status"
	| "revoke";

export type CommandDefinition = {
	name: CommandName;
	description: string;
	usage: string;
	args: "none" | "optional" | "required";
};

export const COMMANDS: CommandDefinition[] = [
	{ name: "bash", usage: "/bash <shell command>", description: "Run a shell command", args: "required" },
	{ name: "approvals", usage: "/approvals", description: "List pending approvals", args: "none" },
	{ name: "bypasses", usage: "/bypasses", description: "List active approval bypasses", args: "none" },
	{ name: "approve", usage: "/approve <approval-id>", description: "Approve a pending approval", args: "required" },
	{ name: "deny", usage: "/deny <approval-id>", description: "Deny a pending approval", args: "required" },
	{ name: "cancel", usage: "/cancel <turn-id>", description: "Cancel a running turn", args: "required" },
	{ name: "status", usage: "/status", description: "Show this thread status", args: "optional" },
	{ name: "revoke", usage: "/revoke <bypass-id>", description: "Revoke an approval bypass", args: "required" },
	{ name: "help", usage: "/help", description: "Show command help", args: "none" },
];

export const COMMAND_NAMES = new Set<CommandName>(COMMANDS.map((command) => command.name));

export function commandDefinition(name: string): CommandDefinition | undefined {
	return COMMANDS.find((command) => command.name === name);
}

export function commandText(name: string, args = ""): string | undefined {
	const command = commandDefinition(name);
	if (!command) return undefined;
	const trimmed = args.trim();
	if (trimmed && command.args === "none") return undefined;
	return trimmed ? `/${name} ${trimmed}` : `/${name}`;
}

export function isControlCommand(input: string): boolean {
	const text = input.trim();
	if (!text.startsWith("/")) return false;
	const [rawName, ...rest] = text.slice(1).split(/\s+/u);
	const command = commandDefinition(rawName.toLowerCase());
	if (!command) return false;
	const args = rest.join(" ").trim();
	if (command.args === "required") return Boolean(args);
	if (command.args === "none") return !args;
	return true;
}
