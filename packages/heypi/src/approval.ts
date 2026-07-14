import { randomUUID } from "node:crypto";
import type { ExtensionFactory } from "@earendil-works/pi-coding-agent";
import type {
	AdapterApprovalConfig,
	AdapterKind,
	ApprovalContext,
	ApprovalDecision,
	ApprovalLayout,
	ApprovalPolicy,
	ApprovalPolicyResult,
	ApprovalState,
	ApprovalView,
	ApproverSet,
} from "./types.js";

export type CommandPolicyConfig = {
	allow?: RegExp[];
	approve?: RegExp[];
	block?: RegExp[];
};

export type CommandRisk = {
	risk: "allow" | "approval" | "block";
	reason: string;
};

export type ApprovalRow = {
	label: string;
	value: string;
	format?: "code" | "text";
};

const BLOCK_COMMANDS: RegExp[] = [/\brm\s+-rf\s+\/(?:\s|$)/i, /\bmkfs\b/i, /\bshutdown\b/i, /\breboot\b/i];

const APPROVAL_COMMANDS: RegExp[] = [
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

export function approvalLayout(config?: AdapterApprovalConfig): ApprovalLayout {
	return config?.layout === "card" ? "card" : "message";
}

export function approvalTitle(state: ApprovalState = "pending"): string {
	if (state === "approved") return "Approved";
	if (state === "rejected") return "Rejected";
	return "Approval required";
}

export function approvalRows(view: ApprovalView): ApprovalRow[] {
	const rows: ApprovalRow[] = [{ label: "Reason", value: view.reason }];
	if (view.detail && view.detailLabel) rows.push({ label: view.detailLabel, value: view.detail });
	if (view.command) rows.push({ label: "Command", value: view.command, format: "code" });
	if (view.showId) rows.push({ label: "Approval ID", value: view.id });
	if (view.requestedBy) rows.push({ label: "Requested by", value: view.requestedBy });
	if (view.state === "approved" && view.resolvedBy) rows.push({ label: "Approved by", value: view.resolvedBy });
	if (view.state === "rejected" && view.resolvedBy) rows.push({ label: "Rejected by", value: view.resolvedBy });
	return rows;
}

export function renderApprovalMessage(view: ApprovalView): string {
	const lines = [`*${approvalTitle(view.state)}*`];
	for (const row of approvalRows(view)) {
		lines.push(
			row.format === "code" ? `- ${row.label}:\n\`\`\`\n${row.value}\n\`\`\`` : `- ${row.label}: ${row.value}`,
		);
	}
	return lines.join("\n");
}

function toolInputDetail(input: unknown): { detailLabel?: string; detail?: string; command?: string } {
	if (!input || typeof input !== "object") return {};
	const record = input as Record<string, unknown>;
	const command = typeof record.command === "string" ? record.command : undefined;
	if (command) return { command };
	const detail = JSON.stringify(record);
	return detail === "{}" ? {} : { detailLabel: "Input", detail };
}

export type ApprovalExtensionOptions = {
	config?: AdapterApprovalConfig;
	admins?: ApproverSet;
	approvers?: ApproverSet;
	policies?: Record<string, ApprovalPolicy | false | undefined>;
	context?: () => Partial<Omit<ApprovalContext, "toolName" | "input" | "approvedTools">>;
	request(view: ApprovalView): Promise<ApprovalDecision>;
};

function matches(pattern: RegExp, text: string): boolean {
	pattern.lastIndex = 0;
	return pattern.test(text);
}

export function classifyCommand(command: string, config: CommandPolicyConfig = {}): CommandRisk {
	for (const pattern of [...(config.block ?? []), ...BLOCK_COMMANDS]) {
		if (matches(pattern, command)) return { risk: "block", reason: `Blocked by ${pattern}` };
	}
	for (const pattern of config.allow ?? []) {
		if (matches(pattern, command)) return { risk: "allow", reason: `Allowed by ${pattern}` };
	}
	for (const pattern of [...(config.approve ?? []), ...APPROVAL_COMMANDS]) {
		if (matches(pattern, command)) return { risk: "approval", reason: `Approval by ${pattern}` };
	}
	return { risk: "allow", reason: "Safe default" };
}

function inputCommand(input: unknown): string | undefined {
	if (!input || typeof input !== "object") return undefined;
	const command = (input as Record<string, unknown>).command;
	return typeof command === "string" ? command : undefined;
}

function approvalView(
	id: string,
	context: ApprovalContext,
	result: Extract<ApprovalPolicyResult, { type: "approve" }>,
	showId: boolean,
	layout: ApprovalLayout,
): ApprovalView {
	const detail = toolInputDetail(context.input);
	return {
		id,
		layout,
		reason: result.reason,
		requestedBy: context.actor?.name ?? context.actor?.id,
		showId,
		...detail,
		detailLabel: result.detailLabel ?? detail.detailLabel,
		detail: result.detail ?? detail.detail,
		command: result.command ?? detail.command,
	};
}

function matchesAny(values: string[] | undefined, candidates: Iterable<string | undefined>): boolean {
	if (!values?.length) return false;
	const allowed = new Set(values);
	for (const candidate of candidates) {
		if (candidate && allowed.has(candidate)) return true;
	}
	return false;
}

export function approvalActorAllowed(
	decision: ApprovalDecision,
	approvers?: ApproverSet,
	admins?: ApproverSet,
): boolean {
	if (!approvers && !admins) return true;
	const users = [decision.resolvedById, decision.resolvedBy];
	const roles = decision.roles ?? [];
	const groups = decision.groups ?? [];
	if (matchesAny(admins?.users, users)) return true;
	if (matchesAny(admins?.roles, roles)) return true;
	if (matchesAny(admins?.groups, groups)) return true;
	if (!approvers) return false;
	if (matchesAny(approvers.users, users)) return true;
	if (matchesAny(approvers.roles, roles)) return true;
	if (matchesAny(approvers.groups, groups)) return true;
	return false;
}

type ApprovalPredicate = (context: ApprovalContext) => boolean | Promise<boolean>;
type ApprovalReason = string | ((context: ApprovalContext) => string);

function reasonText(reason: ApprovalReason, context: ApprovalContext): string {
	return typeof reason === "function" ? reason(context) : reason;
}

export const approval = {
	never(): ApprovalPolicy {
		return () => false;
	},

	always(reason: ApprovalReason = ({ toolName }) => `Run ${toolName} tool.`): ApprovalPolicy {
		return (context) => ({ type: "approve", reason: reasonText(reason, context) });
	},

	once(reason: ApprovalReason = ({ toolName }) => `Run ${toolName} tool.`): ApprovalPolicy {
		return (context) => {
			if (context.approvedTools.has(context.toolName)) return false;
			return { type: "approve", reason: reasonText(reason, context) };
		};
	},

	when(predicate: ApprovalPredicate, reason: ApprovalReason): ApprovalPolicy {
		return async (context) => {
			if (!(await predicate(context))) return false;
			return { type: "approve", reason: reasonText(reason, context) };
		};
	},

	command(config: CommandPolicyConfig = {}): ApprovalPolicy {
		return (context) => {
			const command = inputCommand(context.input);
			if (!command) return false;
			const risk = classifyCommand(command, config);
			if (risk.risk === "allow") return false;
			if (risk.risk === "block") return { type: "block", reason: risk.reason };
			return { type: "approve", reason: "Run bash command.", command };
		};
	},
};

export function createApprovalExtension(options: ApprovalExtensionOptions): ExtensionFactory {
	const approvedTools = new Set<string>();
	return (pi) => {
		pi.on("tool_call", async (toolCall) => {
			const policy = options.policies?.[toolCall.toolName];
			if (!policy) return;
			const extra = options.context?.() ?? {};
			const context: ApprovalContext = {
				toolName: toolCall.toolName,
				input: toolCall.input,
				approvedTools,
				adapter: extra.adapter as AdapterKind | string | undefined,
				adapterId: extra.adapterId,
				conversation: extra.conversation,
				thread: extra.thread,
				actor: extra.actor,
			};
			const result = await policy(context);
			if (!result) return;
			if (result.type === "block") return { block: true, reason: result.reason };
			const id = randomUUID();
			const view = approvalView(
				id,
				context,
				result,
				options.config?.showId ?? false,
				approvalLayout(options.config),
			);
			const decision = await options.request(view);
			if (!decision.approved) return { block: true, reason: decision.reason ?? "Tool call rejected." };
			if (!approvalActorAllowed(decision, options.approvers, options.admins)) {
				return { block: true, reason: "Approval actor is not allowed to approve this tool call." };
			}
			approvedTools.add(context.toolName);
		});
	};
}
