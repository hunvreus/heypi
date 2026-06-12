import { isRuntimeStartupErrorText, RUNTIME_STARTUP_ERROR_KIND } from "../runtime/errors.js";
import type { ApprovalBypass } from "../store/types.js";
import { codeFence } from "./approval-view.js";
import { redact } from "./log.js";
import { type AppMessages, DEFAULT_APP_MESSAGES } from "./messages.js";
import type { ApprovalDetail, CallErrorKind, Reply } from "./types.js";

export type ApprovalSummary = {
	id: string;
	callId: string;
	channel: string;
	command: string;
	runtime: string;
	reason: string;
	requestedAt: number;
	expiresAt: number | null;
	requestedBy: string | null;
};

export function helpReply(): Reply {
	return {
		text: [
			"Commands:",
			"- /bash <shell command>",
			"- /approvals: list pending approvals",
			"- /bypasses: list active approval bypasses",
			"- /approve <approval-id>",
			"- /deny <approval-id>",
			"- /cancel <turn-id>",
			"- /status: show this thread status",
			"- /status <call-id>: show one call status",
			"- any other text: handled by the assistant",
		].join("\n"),
	};
}

export function renderApprovals(rows: ApprovalSummary[]): Reply {
	if (!rows.length) return { text: "No pending approvals.", private: true };
	const lines = ["Pending approvals"];
	for (const row of rows) {
		const label = row.runtime === "tool" ? row.command : row.runtime;
		const age = Math.max(0, Date.now() - row.requestedAt);
		lines.push(
			[
				`- \`${row.id}\``,
				`\`${redact(label)}\``,
				row.reason,
				`requested ${formatDuration(age)} ago`,
				row.expiresAt ? `expires in ${formatDuration(Math.max(0, row.expiresAt - Date.now()))}` : undefined,
			]
				.filter((item): item is string => typeof item === "string")
				.join(" — "),
		);
	}
	lines.push("", "Use `/approve <approval-id>` or `/deny <approval-id>`.");
	return { text: lines.join("\n"), private: true };
}

export function renderApprovalBypasses(rows: ApprovalBypass[]): Reply {
	if (!rows.length) return { text: "No active approval bypasses.", private: true };
	const lines = ["Active approval bypasses"];
	for (const row of rows) {
		const remaining = Math.max(0, row.expiresAt - Date.now());
		lines.push(
			[
				`- \`${row.id}\``,
				`scope ${row.scope}`,
				`target ${bypassTarget(row)}`,
				row.actor ? `actor ${row.actor}` : undefined,
				`created by ${row.createdBy}`,
				`expires in ${formatDuration(remaining)}`,
			]
				.filter((item): item is string => typeof item === "string")
				.join(" — "),
		);
	}
	lines.push("", "Use `/revoke <bypass-id>` to revoke a bypass.");
	return { text: lines.join("\n"), private: true };
}

function bypassTarget(row: ApprovalBypass): string {
	if (row.scope === "thread") return row.threadId ? `thread ${row.threadId}` : "thread";
	if (row.scope === "channel") return `channel ${row.channel}`;
	if (row.scope === "user") return row.actor ? `user ${row.actor}` : "user";
	return `adapter ${row.channel.split(":")[0] ?? row.channel}`;
}

export function renderThreadStatus(input: {
	active?: { id: string; state: string; trace: string | null; updatedAt: number };
	turns: Array<{ id: string; state: string; trace: string | null; updatedAt: number }>;
	calls: Array<{ id: string; tool: string; state: string; command: string | null; updatedAt: number }>;
	approvals: Array<{
		id: string;
		callId: string;
		command: string;
		runtime: string;
		reason: string;
		state: string;
		requestedAt: number;
	}>;
	lock?: { owner: string; expiresAt: number };
}): Reply {
	const lines = ["Thread status"];
	const busyMs = input.lock ? Math.max(0, input.lock.expiresAt - Date.now()) : 0;
	lines.push(
		input.active
			? `Active: \`${input.active.state}\` for ${formatDuration(Date.now() - input.active.updatedAt)}`
			: "Active: none",
	);
	if (input.approvals.length) {
		lines.push("", "Pending approvals:");
		for (const row of input.approvals) {
			const label = row.runtime === "tool" ? row.command : row.runtime;
			lines.push(`- \`${label}\` — ${row.reason}`);
		}
	}
	if (input.calls.length) {
		lines.push("", "Calls needing attention:");
		for (const row of input.calls)
			lines.push(`- \`${row.tool}\` — ${row.state}${row.command ? ` — \`${redact(row.command)}\`` : ""}`);
	}
	if (input.lock) lines.push("", `Busy for up to ${formatDuration(busyMs)}.`);
	if (input.active && !input.approvals.length && !input.calls.length) {
		lines.push("", "Current activity: waiting for model or tool output.");
	} else if (!input.active && !input.lock && !input.approvals.length && !input.calls.length) {
		lines.push("", "Nothing needs action.");
	}
	return { text: lines.join("\n"), private: true };
}

export function renderCall(input: {
	callId: string;
	state: string;
	code?: number;
	out?: string;
	err?: string;
	errKind?: CallErrorKind | null;
	ms?: number;
	approvalId?: string;
	reason?: string;
	command?: string;
	runtime?: string;
	approvers?: string[];
	requestedBy?: string;
	details?: ApprovalDetail[];
	messages?: AppMessages;
	runtimeFailed?: boolean;
}): Reply {
	if (input.state === "pending_approval") {
		const command = input.command ? redact(input.command) : undefined;
		const reason = input.reason ? redact(input.reason) : "Policy requires approval.";
		return {
			text: [
				"*Approval required*",
				reason,
				...detailLines(input.details),
				input.approvers?.length ? `Approvers: ${input.approvers.join(", ")}` : undefined,
			]
				.filter((line): line is string => typeof line === "string")
				.join("\n"),
			approval: input.approvalId
				? {
						id: input.approvalId,
						callId: input.callId,
						command: command ?? "",
						runtime: input.runtime ?? "",
						reason: input.reason ?? "policy",
						allowed: input.approvers ?? [],
						...(input.requestedBy ? { requestedBy: input.requestedBy } : {}),
						...(input.details !== undefined ? { details: input.details } : {}),
					}
				: undefined,
		};
	}
	if (input.state === "unauthorized") {
		return {
			text: [
				input.messages?.approvalUnauthorized ?? "You are not allowed to resolve this action.",
				input.approvers?.length ? `Allowed approvers: ${input.approvers.join(", ")}` : undefined,
			]
				.filter((line): line is string => typeof line === "string")
				.join("\n"),
			private: true,
		};
	}
	if (input.state === "blocked") {
		return {
			text:
				input.reason === "denied"
					? `Action \`${input.callId}\` rejected.`
					: ["Action blocked", input.reason ?? "Policy blocked this action."].join("\n"),
		};
	}
	const startupFailed =
		input.runtimeFailed ||
		input.errKind === RUNTIME_STARTUP_ERROR_KIND ||
		(input.errKind === undefined && isRuntimeStartupErrorText(input.err));
	const err =
		input.err && startupFailed ? (input.messages?.runtimeFailed ?? DEFAULT_APP_MESSAGES.runtimeFailed) : input.err;
	return {
		text: [
			`Result: \`${input.state}\`${typeof input.code === "number" ? ` exit=${input.code}` : ""}${
				typeof input.ms === "number" ? ` ${input.ms}ms` : ""
			}`,
			input.out ? ["", "Output:", codeBlock(input.out)].join("\n") : undefined,
			err ? ["", "Error:", codeBlock(err)].join("\n") : undefined,
		]
			.filter((line): line is string => typeof line === "string")
			.join("\n"),
	};
}

function codeBlock(value: string): string {
	return ["```", value, "```"].join("\n");
}

function detailLines(details: ApprovalDetail[] | undefined): string[] {
	if (!details?.length) return [];
	return details.flatMap((detail) => [
		"",
		`${detail.label}:`,
		detail.format === "code" ? codeFence(redact(detail.value)) : redact(detail.value),
	]);
}

function formatDuration(ms: number): string {
	const seconds = Math.floor(ms / 1000);
	if (seconds < 60) return `${seconds}s`;
	const minutes = Math.floor(seconds / 60);
	if (minutes < 60) return `${minutes}m`;
	const hours = Math.floor(minutes / 60);
	if (hours < 48) return `${hours}h`;
	return `${Math.floor(hours / 24)}d`;
}
