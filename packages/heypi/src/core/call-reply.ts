import { parseApprovalDetails } from "./approval-view.js";
import { renderCall } from "./format.js";
import type { ApprovalResolution, Reply } from "./types.js";

const CALL_ARG_META = "__heypi";

export function staleApproval(text: string): Reply {
	return { text, private: true, replaceOriginal: true };
}

export function approvalSummary(
	approval: {
		id: string;
		callId: string;
		reason: string;
		runtime: string;
		requestedBy?: string | null;
		details?: string | null;
	},
	call: { tool: string; command: string | null; args: string | null },
	approvers: string[],
	resolution?: ApprovalResolution,
): Reply {
	return {
		...renderCall({
			callId: approval.callId,
			state: "pending_approval",
			approvalId: approval.id,
			reason: approval.reason,
			command: call.command ?? `${call.tool} ${callArgsText(call.args)}`.trim(),
			runtime: approval.runtime,
			approvers,
			requestedBy: approval.requestedBy ?? undefined,
			details: parseApprovalDetails(approval.details),
		}),
		approvalResolution: resolution,
	};
}

export function callContext(call: {
	agent?: string | null;
	trace?: string | null;
	threadId: string | null;
	turnId: string | null;
	messageId: string | null;
	toolCallId: string | null;
	args?: string | null;
}) {
	const parsed = parseCallArgs(call.args ?? null);
	return {
		...(call.agent ? { agent: call.agent } : {}),
		...(call.trace ? { trace: call.trace } : {}),
		thread: call.threadId ?? undefined,
		turn: call.turnId ?? undefined,
		message: call.messageId ?? undefined,
		toolCall: call.toolCallId ?? undefined,
		runtimeScope: parsed.meta.runtimeScope,
	};
}

export function callArgsForStorage(args: Record<string, unknown>, context?: { runtimeScope?: string }): string {
	if (CALL_ARG_META in args) throw new Error(`${CALL_ARG_META} is reserved for heypi call metadata`);
	if (!context?.runtimeScope) return JSON.stringify(args);
	return JSON.stringify({ ...args, [CALL_ARG_META]: { runtimeScope: context.runtimeScope } });
}

export function callArgs(input: string | null): Record<string, unknown> {
	return parseCallArgs(input).args;
}

function callArgsText(input: string | null): string {
	if (!input) return "";
	return JSON.stringify(callArgs(input));
}

function parseCallArgs(input: string | null): { args: Record<string, unknown>; meta: { runtimeScope?: string } } {
	if (!input) return { args: {}, meta: {} };
	let parsed: unknown;
	try {
		parsed = JSON.parse(input) as unknown;
	} catch {
		return { args: {}, meta: {} };
	}
	if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return { args: {}, meta: {} };
	const record = parsed as Record<string, unknown>;
	const meta = callMeta(record[CALL_ARG_META]);
	const { [CALL_ARG_META]: _internal, ...args } = record;
	return { args, meta };
}

function callMeta(value: unknown): { runtimeScope?: string } {
	if (!value || typeof value !== "object" || Array.isArray(value)) return {};
	const runtimeScope = (value as Record<string, unknown>).runtimeScope;
	return typeof runtimeScope === "string" ? { runtimeScope } : {};
}

export function continuation(
	callId: string,
	tool: string,
	context: {
		thread?: string;
		turn?: string;
		toolCall?: string;
	},
	actor: string | null | undefined,
	out: string,
	err: string,
	isError: boolean,
): Reply["continuation"] {
	if (!context.thread || !context.toolCall) return undefined;
	return {
		threadId: context.thread,
		...(context.turn ? { turnId: context.turn } : {}),
		toolCallId: context.toolCall,
		tool,
		actor: actor ?? undefined,
		out: out || `call=${callId}`,
		err,
		isError,
	};
}
