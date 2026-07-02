import type { ApprovalLayout } from "./types.js";

export type ApprovalState = "pending" | "approved" | "rejected";

export type ApprovalView = {
	reason: string;
	requestedBy?: string;
	detailLabel?: string;
	detail?: string;
	command?: string;
	state?: ApprovalState;
	resolvedBy?: string;
	showId?: boolean;
	id?: string;
};

export type ApprovalOptions = {
	layout?: ApprovalLayout;
	showId?: boolean;
};

export function approval(options: ApprovalOptions = {}): ApprovalOptions {
	return options;
}

export function renderApprovalMessage(view: ApprovalView): string {
	const lines = ["*Approval required*"];
	lines.push(`- *Reason:* ${view.reason}`);
	if (view.detail && view.detailLabel) lines.push(`- *${view.detailLabel}:* ${view.detail}`);
	if (view.command) lines.push(`- *Command:*\n\`\`\`\n${view.command}\n\`\`\``);
	if (view.showId && view.id) lines.push(`- *Approval ID:* ${view.id}`);
	if (view.requestedBy) lines.push(`- *Requested by:* ${view.requestedBy}`);
	if (view.state === "approved" && view.resolvedBy) lines.push(`- *Approved by:* ${view.resolvedBy}`);
	if (view.state === "rejected" && view.resolvedBy) lines.push(`- *Rejected by:* ${view.resolvedBy}`);
	return lines.join("\n");
}
