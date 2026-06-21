import type { ApprovalDetail, ApprovalPrompt, ApprovalResolution } from "./types.js";

const APPROVAL_DETAIL_VALUE_LIMIT = 1800;
const APPROVAL_DETAIL_LABEL_LIMIT = 80;
const APPROVAL_DETAIL_COUNT_LIMIT = 20;

export type ApprovalViewState = "pending" | ApprovalResolution;

export type ApprovalViewRow = {
	label: string;
	value: string;
	format?: "code" | "text";
};

export function approvalViewTitle(state: ApprovalViewState): string {
	return approvalStateTitle(state === "pending" ? undefined : state);
}

export function approvalViewRows(input: {
	approval?: ApprovalPrompt;
	state: ApprovalViewState;
	actor?: string;
	formatActor?: (actor: string) => string;
}): ApprovalViewRow[] {
	const rows: ApprovalViewRow[] = [];
	if (input.approval?.reason) rows.push({ label: "Reason", value: input.approval.reason });
	for (const detail of input.approval?.details ?? []) {
		rows.push({ label: detail.label, value: detail.value, format: detail.format });
	}
	if (input.approval?.id) rows.push({ label: "Approval ID", value: input.approval.id });
	if (input.approval?.requestedBy) {
		rows.push({
			label: "Requested by",
			value: input.formatActor ? input.formatActor(input.approval.requestedBy) : input.approval.requestedBy,
		});
	}
	const resolution = approvalResolutionRow(input.state, input.actor, input.formatActor);
	if (resolution) rows.push(resolution);
	return rows;
}

export function approvalViewText(input: {
	text: string;
	approval?: ApprovalPrompt;
	state?: ApprovalResolution;
	actor?: string;
	formatActor?: (actor: string) => string;
	formatTitle?: (title: string) => string;
	formatLabel?: (label: string) => string;
	formatCode?: (value: string) => string;
	formatRow?: (row: ApprovalViewRow) => string;
	separator?: string;
}): string {
	if (!input.approval) return input.text;
	const state = input.state ?? "pending";
	const title = input.formatTitle?.(approvalViewTitle(state)) ?? approvalViewTitle(state);
	const rows = approvalViewRows({
		approval: input.approval,
		state,
		actor: input.actor,
		formatActor: input.formatActor,
	}).map((row) => {
		if (input.formatRow) return input.formatRow(row);
		const label = input.formatLabel?.(row.label) ?? row.label;
		const value = row.format === "code" ? (input.formatCode?.(row.value) ?? row.value) : row.value;
		return [label, value].join("\n");
	});
	return [title, ...rows].filter(Boolean).join(input.separator ?? "\n\n");
}

export function normalizeApprovalDetails(input: unknown): ApprovalDetail[] | undefined {
	if (!Array.isArray(input)) return undefined;
	const details: ApprovalDetail[] = [];
	let omitted = 0;
	for (const item of input) {
		if (!item || typeof item !== "object") continue;
		const record = item as Record<string, unknown>;
		if (typeof record.label !== "string" || typeof record.value !== "string") continue;
		const label = truncate(record.label.trim(), APPROVAL_DETAIL_LABEL_LIMIT);
		if (!label) continue;
		if (details.length >= APPROVAL_DETAIL_COUNT_LIMIT) {
			omitted++;
			continue;
		}
		details.push({
			label,
			value: truncate(record.value, APPROVAL_DETAIL_VALUE_LIMIT),
			format: record.format === "code" ? "code" : "text",
		});
	}
	if (omitted) {
		details.push({
			label: "Additional details",
			value: `${omitted} omitted.`,
			format: "text",
		});
	}
	return details.length ? details : [];
}

export function parseApprovalDetails(input: string | null | undefined): ApprovalDetail[] | undefined {
	if (!input) return undefined;
	try {
		return normalizeApprovalDetails(JSON.parse(input) as unknown);
	} catch {
		return undefined;
	}
}

export function serializeApprovalDetails(input: ApprovalDetail[] | undefined): string | undefined {
	if (input === undefined) return undefined;
	return JSON.stringify(normalizeApprovalDetails(input) ?? []);
}

export function codeFence(value: string): string {
	return ["```", escapeCodeFence(value), "```"].join("\n");
}

export function approvalStateTitle(state?: ApprovalResolution): string {
	if (state === "approved") return "Approved";
	if (state === "rejected") return "Rejected";
	if (state === "expired") return "Expired";
	return "Approval required";
}

export function approvalStateLine(state: ApprovalResolution, actor?: string): string {
	if (state === "approved") return actor ? `Approved by ${actor}.` : "Approved.";
	if (state === "rejected") return actor ? `Rejected by ${actor}.` : "Rejected.";
	return "Approval expired.";
}

function approvalResolutionRow(
	state: ApprovalViewState,
	actor?: string,
	formatActor?: (actor: string) => string,
): ApprovalViewRow | undefined {
	if (state === "approved") {
		return { label: "Approved by", value: actor ? (formatActor?.(actor) ?? actor) : approvalStateTitle(state) };
	}
	if (state === "rejected") {
		return { label: "Rejected by", value: actor ? (formatActor?.(actor) ?? actor) : approvalStateTitle(state) };
	}
	if (state === "expired") return { label: "Status", value: approvalStateTitle(state) };
	return undefined;
}

function escapeCodeFence(value: string): string {
	return value.replaceAll("```", "`\u200b``");
}

function truncate(value: string, limit: number): string {
	if (value.length <= limit) return value;
	return `${value.slice(0, Math.max(0, limit - 1))}…`;
}
