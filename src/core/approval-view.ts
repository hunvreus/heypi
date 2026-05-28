import type { ApprovalDetail, ApprovalResolution } from "./types.js";

const APPROVAL_DETAIL_VALUE_LIMIT = 1800;
const APPROVAL_DETAIL_LABEL_LIMIT = 80;
const APPROVAL_DETAIL_COUNT_LIMIT = 20;

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

function escapeCodeFence(value: string): string {
	return value.replaceAll("```", "`\u200b``");
}

function truncate(value: string, limit: number): string {
	if (value.length <= limit) return value;
	return `${value.slice(0, Math.max(0, limit - 1))}…`;
}
