export type CallState = "running" | "pending_approval" | "blocked" | "done" | "failed" | "cancelled";

export type TurnState = "running" | "done" | "failed" | "cancelled";

export type Intent =
	| { kind: "help" }
	| { kind: "ask"; text: string; channel: string; actor: string }
	| { kind: "bash"; cmd: string; channel: string; actor: string }
	| { kind: "approve"; approvalId: string; channel: string; actor: string }
	| { kind: "deny"; approvalId: string; channel: string; actor: string }
	| { kind: "cancel"; id: string; channel: string; actor: string }
	| { kind: "thread_status"; channel: string; actor: string }
	| { kind: "status"; callId: string; channel: string };

export type PolicyDecision =
	| { kind: "allow"; reason: string }
	| { kind: "need_approval"; reason: string }
	| { kind: "block"; reason: string };

export type Reply = {
	text: string;
	private?: boolean;
	silent?: boolean;
	approval?: ApprovalPrompt;
	attachments?: ReplyAttachment[];
	continuation?: ToolContinuation;
};

export type ReplyAttachment = {
	path: string;
	name?: string;
	mimeType?: string;
};

export type ApprovalPrompt = {
	id: string;
	callId: string;
	command: string;
	runtime: string;
	reason: string;
	allowed: string[];
};

export type Confirm = { reason: string } | ((input: Record<string, unknown>) => { reason: string } | false | undefined);

export type ToolExecute = (
	args: Record<string, unknown>,
	signal?: AbortSignal,
) => Promise<{ out: string; err?: string }>;

export type ToolContinuation = {
	threadId: string;
	toolCallId: string;
	tool: string;
	out: string;
	err: string;
	isError: boolean;
};
