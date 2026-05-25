import type { ApprovalDetail } from "./types.js";

export const APPROVAL_DETAIL_VALUE_LIMIT = 1800;
export const APPROVAL_DETAIL_LABEL_LIMIT = 80;

export function normalizeApprovalDetails(input: unknown): ApprovalDetail[] | undefined {
	if (!Array.isArray(input)) return undefined;
	const details: ApprovalDetail[] = [];
	for (const item of input) {
		if (!item || typeof item !== "object") continue;
		const record = item as Record<string, unknown>;
		if (typeof record.label !== "string" || typeof record.value !== "string") continue;
		details.push({
			label: truncate(record.label.trim(), APPROVAL_DETAIL_LABEL_LIMIT),
			value: truncate(record.value, APPROVAL_DETAIL_VALUE_LIMIT),
			format: record.format === "code" ? "code" : "text",
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

function escapeCodeFence(value: string): string {
	return value.replaceAll("```", "`\u200b``");
}

function truncate(value: string, limit: number): string {
	if (value.length <= limit) return value;
	return `${value.slice(0, Math.max(0, limit - 1))}…`;
}
