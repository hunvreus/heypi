import { randomUUID } from "node:crypto";
import type { ExtensionFactory } from "@earendil-works/pi-coding-agent";
import type {
	AdapterKind,
	ApprovalConfig,
	ApprovalContext,
	ApprovalDecision,
	ApprovalLayout,
	ApprovalPolicy,
	ApprovalPolicyResult,
	ApprovalState,
	ApprovalView,
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

export function approvalLayout(config?: ApprovalConfig): ApprovalLayout {
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
	config?: ApprovalConfig;
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

function policyFromConfig(config?: ApprovalConfig): ApprovalPolicy {
	if (config?.policy) return config.policy;
	if (config?.tools?.length) {
		const tools = new Set(config.tools);
		return approval.when(
			({ toolName }) => tools.has(toolName),
			({ toolName }) => `Run ${toolName} tool.`,
		);
	}
	return approval.default();
}

function approvalView(
	id: string,
	context: ApprovalContext,
	result: Extract<ApprovalPolicyResult, { type: "approve" }>,
	showId: boolean,
	layout: ApprovalLayout,
): ApprovalView {
	return {
		id,
		layout,
		reason: result.reason,
		requestedBy: context.actor?.name ?? context.actor?.id,
		showId,
		...toolInputDetail(context.input),
		detailLabel: result.detailLabel ?? toolInputDetail(context.input).detailLabel,
		detail: result.detail ?? toolInputDetail(context.input).detail,
		command: result.command ?? toolInputDetail(context.input).command,
	};
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

	default(): ApprovalPolicy {
		const command = approval.command();
		const edit = approval.when(
			({ toolName }) => toolName === "edit" || toolName === "write",
			({ toolName }) => `Run ${toolName} tool.`,
		);
		return async (context) => {
			if (context.toolName === "bash") return command(context);
			return edit(context);
		};
	},
};

export function createApprovalExtension(options: ApprovalExtensionOptions): ExtensionFactory {
	const policy = policyFromConfig(options.config);
	const approvedTools = new Set<string>();
	return (pi) => {
		pi.on("tool_call", async (toolCall) => {
			const extra = options.context?.() ?? {};
			const context: ApprovalContext = {
				toolName: toolCall.toolName,
				input: toolCall.input,
				approvedTools,
				adapter: extra.adapter as AdapterKind | string | undefined,
				account: extra.account,
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
			approvedTools.add(context.toolName);
		});
	};
}
