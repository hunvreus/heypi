import type { ApprovalBypassConfig, ApprovalBypassScope, ApprovalPolicy } from "../config.js";
import type { Approval, ApprovalBypasses } from "../store/types.js";
import type { Logger } from "./log.js";

const DEFAULT_BYPASS_DURATION_MS = 5 * 60_000;
const DEFAULT_BYPASS_MAX_DURATION_MS = 15 * 60_000;
const DEFAULT_BYPASS_SCOPE: ApprovalBypassScope = "thread";

export type BypassCallBase = {
	channel: string;
	actor: string;
	tool: string;
	context?: {
		agent?: string;
		thread?: string;
	};
};

export function config(policy: ApprovalPolicy): Required<ApprovalBypassConfig> | undefined {
	if (!policy.bypass) return undefined;
	const durationMs = clampPositive(
		policy.bypass.durationMs,
		DEFAULT_BYPASS_DURATION_MS,
		policy.bypass.maxDurationMs ?? DEFAULT_BYPASS_MAX_DURATION_MS,
	);
	const maxDurationMs = Math.max(durationMs, policy.bypass.maxDurationMs ?? DEFAULT_BYPASS_MAX_DURATION_MS);
	return {
		durationMs,
		maxDurationMs,
		scope: policy.bypass.scope ?? DEFAULT_BYPASS_SCOPE,
	};
}

export async function active(input: {
	base: BypassCallBase;
	policy: ApprovalPolicy;
	agent: string;
	approvalBypasses?: ApprovalBypasses;
	log: Logger;
}): Promise<boolean> {
	const { base, policy, agent, approvalBypasses, log } = input;
	if (!approvalBypasses) return false;
	const settings = config(policy);
	if (!settings) return false;
	const bypass = await approvalBypasses.active({
		agent,
		channel: base.channel,
		threadId: base.context?.thread,
		actor: base.actor,
	});
	if (!bypass) return false;
	log.info("approval_bypass.used", {
		...base.context,
		bypass: bypass.id,
		channel: base.channel,
		tool: base.tool,
		scope: bypass.scope,
		expiresAt: bypass.expiresAt,
	});
	return true;
}

export async function create(input: {
	approval: Approval;
	call: { threadId: string | null; actor: string | null };
	actor: string;
	context: { thread?: string };
	policy: ApprovalPolicy;
	approvalBypasses?: ApprovalBypasses;
	log: Logger;
}): Promise<Awaited<ReturnType<ApprovalBypasses["create"]>>> {
	const { approval, call, actor, context, policy, approvalBypasses, log } = input;
	const settings = config(policy);
	if (!approvalBypasses || !settings) throw new Error("approval bypasses are disabled");
	const bypass = await approvalBypasses.create({
		agent: approval.agent,
		scope: settings.scope,
		channel: approval.channel,
		threadId: call.threadId ?? context.thread,
		actor: call.actor ?? approval.requestedBy ?? undefined,
		createdBy: actor,
		reason: approval.reason,
		approvalId: approval.id,
		expiresAt: Date.now() + settings.durationMs,
	});
	log.info("approval_bypass.created", {
		bypass: bypass.id,
		approval: approval.id,
		call: approval.callId,
		channel: approval.channel,
		scope: bypass.scope,
		createdBy: actor,
		expiresAt: bypass.expiresAt,
	});
	return bypass;
}

function clampPositive(value: number | undefined, fallback: number, max: number): number {
	if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) return Math.max(1, Math.min(fallback, max));
	return Math.max(1, Math.min(value, max));
}
