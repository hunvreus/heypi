import type { ApprovalPrompt } from "../core/types.js";

export function text(value: string) {
	return { content: [{ type: "text" as const, text: value }], details: { state: "ok" } };
}

export function toolText(value: string, terminate = false, approval?: ApprovalPrompt) {
	return {
		content: [{ type: "text" as const, text: value }],
		details: approval ? { state: "pending_approval", approval } : { state: "ok" },
		terminate,
	};
}

export function stringParam(params: unknown, key: string): string {
	if (
		!params ||
		typeof params !== "object" ||
		!(key in params) ||
		typeof (params as Record<string, unknown>)[key] !== "string"
	) {
		throw new Error(`${key} is required`);
	}
	return (params as Record<string, string>)[key];
}

export function optionalString(params: unknown, key: string): string | undefined {
	if (!params || typeof params !== "object") return undefined;
	const value = (params as Record<string, unknown>)[key];
	return typeof value === "string" ? value : undefined;
}

export function numberParam(params: unknown, key: string): number | undefined {
	if (!params || typeof params !== "object") return undefined;
	const value = (params as Record<string, unknown>)[key];
	return typeof value === "number" ? value : undefined;
}

export function booleanParam(params: unknown, key: string): boolean | undefined {
	if (!params || typeof params !== "object") return undefined;
	const value = (params as Record<string, unknown>)[key];
	return typeof value === "boolean" ? value : undefined;
}
