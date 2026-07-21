import { createHash, randomUUID } from "node:crypto";
import type { ExtensionFactory } from "@earendil-works/pi-coding-agent";
import type { ApprovalRequestedRecord, ApprovalResolvedRecord } from "./channel.js";
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

export type ApprovalAuditRequest = {
	approvalId: string;
	turnId: string;
	triggerRecord: number;
	toolCallId: string;
	toolName: string;
	inputHash: string;
	displayedAction?: string;
	policyReason: string;
	actor: { id: string; name?: string };
	adapter: string;
	adapterId: string;
	conversation: string;
	thread?: string;
	expiresAt?: string;
};

export type ApprovalAuditResolution = {
	approvalId: string;
	decision: ApprovalResolvedRecord["decision"];
	source: ApprovalResolvedRecord["source"];
	approver?: ApprovalResolvedRecord["approver"];
	reason?: string;
	remoteMessageIds?: string[];
};

export type ApprovalAudit = {
	requested(input: ApprovalAuditRequest): Promise<ApprovalRequestedRecord>;
	resolved(input: ApprovalAuditResolution): Promise<ApprovalResolvedRecord>;
	annotationFailed?(error: unknown): void;
};

type ApprovalSettlement = {
	claim(): boolean;
	timer?: ReturnType<typeof setTimeout>;
	update(): Promise<unknown>;
	updateFailed?(error: unknown): void;
	resolve(): void | Promise<void>;
};

/** Resolve a claimed approval even when its platform annotation fails. */
export async function settleApproval(settlement: ApprovalSettlement): Promise<boolean> {
	if (!settlement.claim()) return false;
	if (settlement.timer) clearTimeout(settlement.timer);
	try {
		await settlement.update();
	} catch (error) {
		settlement.updateFailed?.(error);
	} finally {
		await settlement.resolve();
	}
	return true;
}

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
	context?: () => Partial<Omit<ApprovalContext, "toolName" | "input" | "approvedTools">> & {
		turnId?: string;
		triggerRecord?: number;
		inboundMessageId?: string;
	};
	audit?: ApprovalAudit;
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

function canonicalJson(input: unknown): string {
	const seen = new WeakSet<object>();
	const normalize = (value: unknown): unknown => {
		if (value === null || typeof value === "string" || typeof value === "boolean") return value;
		if (typeof value === "number") return Number.isFinite(value) ? value : String(value);
		if (typeof value === "bigint") return value.toString();
		if (value === undefined || typeof value === "function" || typeof value === "symbol") return null;
		if (Array.isArray(value)) return value.map(normalize);
		if (typeof value === "object") {
			if (seen.has(value)) return "[Circular]";
			seen.add(value);
			const record = value as Record<string, unknown>;
			const out: Record<string, unknown> = {};
			for (const key of Object.keys(record).sort()) out[key] = normalize(record[key]);
			return out;
		}
		return String(value);
	};
	return JSON.stringify(normalize(input));
}

export function inputHash(input: unknown): string {
	return createHash("sha256").update(canonicalJson(input)).digest("hex");
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

function toolCallId(toolCall: { id?: unknown; toolCallId?: unknown; callId?: unknown }): string {
	for (const value of [toolCall.toolCallId, toolCall.id, toolCall.callId]) {
		if (typeof value === "string" && value) return value;
	}
	return randomUUID();
}

function displayedAction(view: ApprovalView): string | undefined {
	return view.command ?? view.detail;
}

function resolution(decision: ApprovalDecision): Pick<ApprovalAuditResolution, "decision" | "source" | "reason"> {
	if (decision.approved) return { decision: "approved", source: "adapter_click", reason: decision.reason };
	const reason = decision.reason;
	if (reason === "Approval expired.") return { decision: "expired", source: "timeout", reason };
	if (reason === "Approval canceled.") return { decision: "canceled", source: "turn_cancel", reason };
	return { decision: "rejected", source: "adapter_click", reason };
}

async function annotate(
	pi: unknown,
	type: "heypi.turn" | "heypi.approval.requested" | "heypi.approval.resolved",
	data: unknown,
	onError?: (error: unknown) => void,
): Promise<void> {
	const appendEntry = (pi as { appendEntry?: (customType: string, data: unknown) => void | Promise<void> })
		.appendEntry;
	if (!appendEntry) return;
	try {
		await appendEntry.call(pi, type, data);
	} catch (error) {
		onError?.(error);
	}
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
	const annotatedTurns = new Set<string>();
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
			const callId = toolCallId(toolCall);
			const view = approvalView(
				id,
				context,
				result,
				options.config?.showId ?? false,
				approvalLayout(options.config),
			);
			let requestRecord: ApprovalRequestedRecord | undefined;
			if (options.audit) {
				if (
					!extra.turnId ||
					extra.triggerRecord === undefined ||
					!context.actor ||
					!context.adapter ||
					!context.adapterId ||
					!context.conversation
				) {
					return { block: true, reason: "Approval audit context is incomplete." };
				}
				try {
					requestRecord = await options.audit.requested({
						approvalId: id,
						turnId: extra.turnId,
						triggerRecord: extra.triggerRecord,
						toolCallId: callId,
						toolName: context.toolName,
						inputHash: inputHash(context.input),
						displayedAction: displayedAction(view),
						policyReason: result.reason,
						actor: context.actor,
						adapter: context.adapter,
						adapterId: context.adapterId,
						conversation: context.conversation,
						thread: context.thread,
					});
				} catch {
					return { block: true, reason: "Approval audit write failed." };
				}
				if (!annotatedTurns.has(extra.turnId)) {
					annotatedTurns.add(extra.turnId);
					await annotate(
						pi,
						"heypi.turn",
						{
							turnId: extra.turnId,
							inboundMessageId: extra.inboundMessageId,
							triggerRecord: extra.triggerRecord,
							adapter: context.adapter,
							adapterId: context.adapterId,
							conversation: context.conversation,
							thread: context.thread,
						},
						options.audit.annotationFailed,
					);
				}
				await annotate(
					pi,
					"heypi.approval.requested",
					{
						authoritative: false,
						approvalId: id,
						turnId: extra.turnId,
						toolCallId: callId,
						toolName: context.toolName,
						displayedAction: displayedAction(view),
						policyReason: result.reason,
						heypiRecord: requestRecord.record,
					},
					options.audit.annotationFailed,
				);
			}
			let decision: ApprovalDecision;
			try {
				decision = await options.request(view);
			} catch (error) {
				if (options.audit) {
					try {
						const resolved = await options.audit.resolved({
							approvalId: id,
							decision: "failed",
							source: "post_failed",
							reason: error instanceof Error ? error.message : String(error),
						});
						await annotate(
							pi,
							"heypi.approval.resolved",
							{
								authoritative: false,
								approvalId: id,
								turnId: extra.turnId,
								toolCallId: callId,
								toolName: context.toolName,
								decision: "failed",
								resolvedAt: resolved.resolvedAt,
								heypiRecord: resolved.record,
							},
							options.audit.annotationFailed,
						);
					} catch {}
				}
				return { block: true, reason: "Approval request failed." };
			}
			let outcome = resolution(decision);
			if (decision.approved && !approvalActorAllowed(decision, options.approvers, options.admins)) {
				outcome = {
					decision: "rejected",
					source: "policy_rejection",
					reason: "Approval actor is not allowed to approve this tool call.",
				};
			}
			if (options.audit) {
				let resolved: ApprovalResolvedRecord;
				try {
					resolved = await options.audit.resolved({
						approvalId: id,
						...outcome,
						approver: {
							id: decision.resolvedById,
							name: decision.resolvedBy,
							roles: decision.roles,
							groups: decision.groups,
						},
						remoteMessageIds: decision.messageIds,
					});
				} catch {
					return { block: true, reason: "Approval audit write failed." };
				}
				await annotate(
					pi,
					"heypi.approval.resolved",
					{
						authoritative: false,
						approvalId: id,
						turnId: extra.turnId,
						toolCallId: callId,
						toolName: context.toolName,
						displayedAction: displayedAction(view),
						policyReason: result.reason,
						decision: outcome.decision,
						approverDisplayName: decision.resolvedBy,
						resolvedAt: resolved.resolvedAt,
						heypiRecord: resolved.record,
					},
					options.audit.annotationFailed,
				);
			}
			if (outcome.decision !== "approved") {
				return { block: true, reason: outcome.reason ?? "Tool call rejected." };
			}
			approvedTools.add(context.toolName);
		});
	};
}
