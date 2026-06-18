import type { CompoundList, Node, Script, Statement } from "unbash";
import { parse } from "unbash";
import type { CommandPolicyConfig, CommandRisk, ConfirmFunction } from "./types.js";

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
	/\bufw\s+(allow|deny|delete|enable|disable|reload|reset)\b/i,
	/\bfirewall-cmd\b/i,
	/\biptables\b/i,
	/\bnft\s+(add|delete|flush|insert|replace)\b/i,
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

	const segments = parseCommandSegments(command);
	if (!segments) return { risk: "approval", reason: "approval by unparsed shell" };

	let approval: CommandRisk | undefined;
	let allow: CommandRisk | undefined;
	for (const segment of segments) {
		const risk = classifySegment(segment, config);
		if (risk.risk === "block") return risk;
		if (risk.risk === "approval") approval ??= risk;
		if (risk.risk === "allow" && risk.reason !== "safe default") allow ??= risk;
	}
	return approval ?? allow ?? { risk: "allow", reason: "safe default" };
}

function classifySegment(command: string, config: CommandPolicyConfig): CommandRisk {
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

/** @deprecated Use `approval.command()` instead. */
export function commandConfirm(config: CommandPolicyConfig = {}): ConfirmFunction {
	return (input) => {
		const command = typeof input.command === "string" ? input.command : "";
		const risk = classifyCommand(command, config);
		if (risk.risk === "allow") return false;
		if (risk.risk === "block") return { block: risk.reason, policyReason: risk.reason };
		return {
			message: "Run bash command.",
			policyReason: risk.reason,
			details: command ? [{ label: "Command", value: command, format: "code" }] : undefined,
		};
	};
}

function matches(pattern: RegExp, command: string): boolean {
	pattern.lastIndex = 0;
	return pattern.test(command);
}

function parseCommandSegments(command: string): string[] | undefined {
	let script: Script & { errors?: unknown[] };
	try {
		script = parse(command);
	} catch {
		return undefined;
	}
	if (script.errors?.length) return undefined;

	const segments = collectStatements(script.commands, command);
	return segments?.filter((segment) => segment.trim().length > 0);
}

function collectStatements(statements: Statement[], source: string): string[] | undefined {
	const segments: string[] = [];
	for (const statement of statements) {
		const nested = collectNode(statement.command, source);
		if (!nested) return undefined;
		segments.push(...nested);
	}
	return segments;
}

function collectCompoundList(list: CompoundList, source: string): string[] | undefined {
	return collectStatements(list.commands, source);
}

function collectNode(node: Node, source: string): string[] | undefined {
	switch (node.type) {
		case "Command":
			return [source.slice(node.pos, node.end)];
		case "Statement":
			return collectNode(node.command, source);
		case "Pipeline":
		case "AndOr":
			return collectNodes(node.commands, source);
		case "CompoundList":
			return collectCompoundList(node, source);
		case "If": {
			const clause = collectCompoundList(node.clause, source);
			const then = collectCompoundList(node.then, source);
			const otherwise = node.else ? collectNode(node.else, source) : [];
			return combineSegments(clause, then, otherwise);
		}
		case "For":
		case "While":
		case "Select":
		case "ArithmeticFor":
			return collectCompoundList(node.body, source);
		case "Subshell":
		case "BraceGroup":
			return collectCompoundList(node.body, source);
		case "Function":
		case "Coproc":
			return collectNode(node.body, source);
		case "Case": {
			const items: string[][] = [];
			for (const item of node.items) {
				const body = collectCompoundList(item.body, source);
				if (!body) return undefined;
				items.push(body);
			}
			return items.flat();
		}
		case "TestCommand":
		case "ArithmeticCommand":
			return [source.slice(node.pos, node.end)];
		default:
			return undefined;
	}
}

function collectNodes(nodes: Node[], source: string): string[] | undefined {
	const segments: string[] = [];
	for (const node of nodes) {
		const nested = collectNode(node, source);
		if (!nested) return undefined;
		segments.push(...nested);
	}
	return segments;
}

function combineSegments(...groups: (string[] | undefined)[]): string[] | undefined {
	const segments: string[] = [];
	for (const group of groups) {
		if (!group) return undefined;
		segments.push(...group);
	}
	return segments;
}
