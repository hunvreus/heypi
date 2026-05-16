import type { CommandPolicyConfig, CommandRisk } from "./types.js";

const BLOCK_PATTERNS: RegExp[] = [/\brm\s+-rf\s+\/(?:\s|$)/i, /\bmkfs\b/i, /\bshutdown\b/i, /\breboot\b/i];

const APPROVAL_PATTERNS: RegExp[] = [
	/\bcurl\b/i,
	/\bwget\b/i,
	/\bssh\b/i,
	/\bscp\b/i,
	/\brsync\b/i,
	/\bdocker\b/i,
	/\bkubectl\b/i,
	/\bterraform\b/i,
	/\bhelm\b/i,
	/\bgit\s+push\b/i,
	/\bnpm\s+publish\b/i,
	/\bpnpm\s+publish\b/i,
	/\brm\s+-rf\b/i,
];

/** Classifies command risk for governance. It does not provide OS isolation. */
export function classifyCommand(command: string, config: CommandPolicyConfig = {}): CommandRisk {
	for (const pattern of [...(config.block ?? []), ...BLOCK_PATTERNS]) {
		if (matches(pattern, command)) return { risk: "block", reason: `blocked by ${pattern}` };
	}
	for (const pattern of config.allow ?? []) {
		if (matches(pattern, command)) return { risk: "allow", reason: `allowed by ${pattern}` };
	}
	for (const pattern of [...(config.approve ?? []), ...APPROVAL_PATTERNS]) {
		if (matches(pattern, command)) return { risk: "approval", reason: `approval by ${pattern}` };
	}
	return { risk: "allow", reason: "safe default" };
}

function matches(pattern: RegExp, command: string): boolean {
	pattern.lastIndex = 0;
	return pattern.test(command);
}
