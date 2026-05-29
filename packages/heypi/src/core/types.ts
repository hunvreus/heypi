import type { Runtime } from "../runtime/types.js";

export type CallState = "running" | "pending_approval" | "blocked" | "done" | "failed" | "cancelled";

export type TurnState = "running" | "done" | "failed" | "cancelled";

export type Intent =
	| { kind: "help" }
	| { kind: "ask"; text: string; channel: string; actor: string }
	| { kind: "bash"; cmd: string; channel: string; actor: string }
	| { kind: "approve"; approvalId: string; channel: string; actor: string }
	| { kind: "deny"; approvalId: string; channel: string; actor: string }
	| { kind: "cancel"; id: string; channel: string; actor: string }
	| { kind: "approvals"; channel: string; actor: string }
	| { kind: "thread_status"; channel: string; actor: string }
	| { kind: "status"; callId: string; channel: string };

export type CommandPolicyConfig = {
	allow?: RegExp[];
	approve?: RegExp[];
	block?: RegExp[];
};

export type CommandRisk = {
	risk: "allow" | "approval" | "block";
	reason: string;
};

export type Reply = {
	text: string;
	private?: boolean;
	silent?: boolean;
	approval?: ApprovalPrompt;
	approvalResolution?: ApprovalResolution;
	replaceOriginal?: boolean;
	attachments?: ReplyAttachment[];
	continuation?: ToolContinuation;
};

export type ReplyAttachment = {
	path: string;
	name?: string;
	mimeType?: string;
	scope?: string;
};

export type ApprovalPrompt = {
	id: string;
	callId: string;
	command: string;
	runtime: string;
	reason: string;
	allowed: string[];
	requestedBy?: string;
	details?: ApprovalDetail[];
};

export type ApprovalDetail = {
	label: string;
	value: string;
	format?: "text" | "code";
};

export type ApprovalResolution = "approved" | "rejected" | "expired";

type ConfirmResult = {
	message?: string;
	reason?: string;
	policyReason?: string;
	block?: string;
	details?: ApprovalDetail[];
};

export type ConfirmFunction = (input: Record<string, unknown>) => ConfirmResult | false | undefined;

export type Confirm = ConfirmResult | ConfirmFunction;

export type ToolExecutionContext = {
	runtime: Runtime;
	runtimeScope?: string;
	signal?: AbortSignal;
};

export type ToolExecute = (
	args: Record<string, unknown>,
	context: ToolExecutionContext,
) => Promise<{ out: string; err?: string }>;

export type ToolContinuation = {
	threadId: string;
	toolCallId: string;
	tool: string;
	actor?: string;
	out: string;
	err: string;
	isError: boolean;
};
