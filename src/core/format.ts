import type { Reply } from "./types.js";

export function helpReply(): Reply {
	return {
		text: [
			"heypi commands:",
			"- bash <shell command>",
			"- approve <approval-id>",
			"- deny <approval-id>",
			"- cancel <turn-id>",
			"- status: show this thread status",
			"- status <call-id>: show one call status",
			"- any other text: handled by Pi agent with bash",
		].join("\n"),
	};
}

export function renderThreadStatus(input: {
	active?: { id: string; state: string; trace: string | null; updatedAt: number };
	turns: Array<{ id: string; state: string; trace: string | null; updatedAt: number }>;
	calls: Array<{ id: string; tool: string; state: string; command: string | null; updatedAt: number }>;
	approvals: Array<{ id: string; callId: string; command: string; state: string; requestedAt: number }>;
	lock?: { owner: string; expiresAt: number };
}): Reply {
	const lines = ["thread status"];
	if (input.active)
		lines.push(`active=${input.active.id} state=${input.active.state} trace=${input.active.trace ?? "n/a"}`);
	else lines.push("active=none");
	if (input.lock)
		lines.push(`lock=${input.lock.owner} expires_in_ms=${Math.max(0, input.lock.expiresAt - Date.now())}`);
	if (input.approvals.length) {
		lines.push("pending approvals:");
		for (const row of input.approvals) lines.push(`- ${row.id} call=${row.callId} cmd=${row.command}`);
	}
	if (input.calls.length) {
		lines.push("calls:");
		for (const row of input.calls)
			lines.push(`- ${row.id} ${row.tool} ${row.state}${row.command ? ` cmd=${row.command}` : ""}`);
	}
	if (input.turns.length) {
		lines.push("recent turns:");
		for (const row of input.turns) lines.push(`- ${row.id} ${row.state} trace=${row.trace ?? "n/a"}`);
	}
	return { text: lines.join("\n"), private: true };
}

export function renderCall(input: {
	callId: string;
	state: string;
	code?: number;
	out?: string;
	err?: string;
	ms?: number;
	approvalId?: string;
	reason?: string;
	command?: string;
	runtime?: string;
	approvers?: string[];
}): Reply {
	if (input.state === "pending_approval") {
		return {
			text: [
				`call=${input.callId}`,
				`state=${input.state}`,
				`approval=${input.approvalId ?? "n/a"}`,
				`reason=${input.reason ?? "policy"}`,
				input.approvers?.length ? `approvers=${input.approvers.join(",")}` : undefined,
				input.command ? "cmd:" : undefined,
				input.command,
			]
				.filter((line): line is string => typeof line === "string")
				.join("\n"),
			approval: input.approvalId
				? {
						id: input.approvalId,
						callId: input.callId,
						command: input.command ?? "",
						runtime: input.runtime ?? "",
						reason: input.reason ?? "policy",
						allowed: input.approvers ?? [],
					}
				: undefined,
		};
	}
	if (input.state === "unauthorized") {
		return {
			text: [
				"You are not allowed to approve this action.",
				input.approvers?.length ? `Allowed approvers: ${input.approvers.join(", ")}` : undefined,
			]
				.filter((line): line is string => typeof line === "string")
				.join("\n"),
			private: true,
		};
	}
	if (input.state === "blocked") {
		return {
			text: [`call=${input.callId}`, `state=${input.state}`, `reason=${input.reason ?? "policy"}`].join("\n"),
		};
	}
	return {
		text: [
			`call=${input.callId}`,
			`state=${input.state}`,
			`code=${input.code ?? -1}`,
			`ms=${input.ms ?? 0}`,
			"out:",
			input.out ?? "",
			"err:",
			input.err ?? "",
		].join("\n"),
	};
}
