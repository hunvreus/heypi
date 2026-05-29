export type MessageValue<T> = string | ((input: T) => string);

export type AppMessages = {
	error: string;
	busyReject: string;
	busyFollowUp: string;
	busySteer: string;
	pendingApprovalReject: string;
	approvalUnavailable: string;
	approvalAlreadyResolved: MessageValue<{ state: string; resolvedBy?: string }>;
	approvalResolved: string;
	approvalExpired: string;
	approvalUnauthorized: string;
	cancelled: string;
	cancelUnauthorized: string;
	cancelNotFound: string;
	approvalsUnauthorized: string;
	runtimeStarting: string | false;
	runtimeFailed: string;
};

export type AppMessagesConfig = Partial<AppMessages>;

export const DEFAULT_APP_MESSAGES: AppMessages = {
	error: "Something went wrong. Ask an admin to check the server logs.",
	busyReject: "I'm still working on the previous message. Send this again after I reply, or use `cancel`.",
	busyFollowUp: "Got it. I'll handle that next.",
	busySteer: "Got it. I'll include that.",
	pendingApprovalReject: "I'm waiting for the pending approval first.",
	approvalUnavailable: "Approval unavailable. Ask me to try again if this is still needed.",
	approvalAlreadyResolved: ({ state, resolvedBy }) => `Approval already ${state} by ${resolvedBy ?? "unknown"}.`,
	approvalResolved: "Approval already resolved.",
	approvalExpired: "Approval expired. Ask me to try again if this is still needed.",
	approvalUnauthorized: "You are not allowed to resolve this action.",
	cancelled: "Cancelled.",
	cancelUnauthorized: "You are not allowed to cancel this run.",
	cancelNotFound: "No active run found for that id.",
	approvalsUnauthorized: "You are not allowed to view pending approvals.",
	runtimeStarting: "Preparing runtime...",
	runtimeFailed: "Runtime failed. Ask an admin to check the server logs.",
};

export function normalizeMessages(input: AppMessagesConfig | undefined): AppMessages {
	return { ...DEFAULT_APP_MESSAGES, ...(input ?? {}) };
}

export function renderMessage<T>(message: MessageValue<T>, input: T): string {
	return typeof message === "function" ? message(input) : message;
}
