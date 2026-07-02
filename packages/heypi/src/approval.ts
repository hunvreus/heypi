import { randomUUID } from "node:crypto";
import type { ExtensionFactory } from "@earendil-works/pi-coding-agent";
import type { ApprovalConfig, ApprovalDecision, ApprovalView } from "./types.js";

export function renderApprovalMessage(view: ApprovalView): string {
	const lines = ["*Approval required*"];
	lines.push(`- Reason: ${view.reason}`);
	if (view.detail && view.detailLabel) lines.push(`- ${view.detailLabel}: ${view.detail}`);
	if (view.command) lines.push(`- Command:\n\`\`\`\n${view.command}\n\`\`\``);
	if (view.showId) lines.push(`- Approval ID: ${view.id}`);
	if (view.requestedBy) lines.push(`- Requested by: ${view.requestedBy}`);
	if (view.state === "approved" && view.resolvedBy) lines.push(`- Approved by: ${view.resolvedBy}`);
	if (view.state === "rejected" && view.resolvedBy) lines.push(`- Rejected by: ${view.resolvedBy}`);
	return lines.join("\n");
}

function toolInputDetail(input: unknown): { detailLabel?: string; detail?: string; command?: string } {
	if (!input || typeof input !== "object") return {};
	const record = input as Record<string, unknown>;
	const command = typeof record.command === "string" ? record.command : undefined;
	if (command) return { command };
	const detail = JSON.stringify(record);
	return detail === "{}" ? {} : { detailLabel: "Input", detail };
}

export type ApprovalExtensionOptions = {
	config?: ApprovalConfig;
	requestedBy?: () => string | undefined;
	request(view: ApprovalView): Promise<ApprovalDecision>;
};

export function createApprovalExtension(options: ApprovalExtensionOptions): ExtensionFactory {
	const guardedTools = new Set(options.config?.tools ?? ["bash", "edit", "write"]);
	return (pi) => {
		pi.on("tool_call", async (toolCall) => {
			if (!guardedTools.has(toolCall.toolName)) return;
			const id = randomUUID();
			const view: ApprovalView = {
				id,
				reason: `Run ${toolCall.toolName} tool.`,
				requestedBy: options.requestedBy?.(),
				showId: options.config?.showId ?? false,
				...toolInputDetail(toolCall.input),
			};
			const decision = await options.request(view);
			if (!decision.approved) return { block: true, reason: decision.reason ?? "Tool call rejected." };
		});
	};
}
