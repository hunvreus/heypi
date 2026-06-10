import { parseApprovalDetails } from "./approval-view.js";
import { renderCall } from "./format.js";
import type { ApprovalResolution, Reply } from "./types.js";

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
			command: call.command ?? `${call.tool} ${call.args ?? ""}`.trim(),
			runtime: approval.runtime,
			approvers,
			requestedBy: approval.requestedBy ?? undefined,
			details: parseApprovalDetails(approval.details),
		}),
		approvalResolution: resolution,
	};
}

export function callContext(call: {
	threadId: string | null;
	turnId: string | null;
	messageId: string | null;
	toolCallId: string | null;
	args?: string | null;
}) {
	const parsed = callArgs(call.args ?? null);
	return {
		thread: call.threadId ?? undefined,
		turn: call.turnId ?? undefined,
		message: call.messageId ?? undefined,
		toolCall: call.toolCallId ?? undefined,
		runtimeScope: typeof parsed.runtimeScope === "string" ? parsed.runtimeScope : undefined,
	};
}

export function callArgs(input: string | null): Record<string, unknown> {
	if (!input) return {};
	const parsed = JSON.parse(input) as unknown;
	return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : {};
}

export function continuation(
	callId: string,
	tool: string,
	context: {
		thread?: string;
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
		toolCallId: context.toolCall,
		tool,
		actor: actor ?? undefined,
		out: out || `call=${callId}`,
		err,
		isError,
	};
}
