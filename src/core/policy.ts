import type { PolicyDecision } from "./types.js";

const BLOCK_PATTERNS: RegExp[] = [/\brm\s+-rf\s+\/$/i, /\bmkfs\b/i, /\bshutdown\b/i, /\breboot\b/i];

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

export function decidePolicy(cmd: string): PolicyDecision {
	for (const pattern of BLOCK_PATTERNS) {
		if (pattern.test(cmd)) {
			return { kind: "block", reason: `blocked by ${pattern}` };
		}
	}
	for (const pattern of APPROVAL_PATTERNS) {
		if (pattern.test(cmd)) {
			return { kind: "need_approval", reason: `approval by ${pattern}` };
		}
	}
	return { kind: "allow", reason: "safe default" };
}
