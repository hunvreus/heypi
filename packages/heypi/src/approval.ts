import type { ExtensionFactory, ToolCallEvent } from "@earendil-works/pi-coding-agent";
import type { ApprovalConfig, ApprovalDecision, ApprovalView } from "./types.js";

export type { ApprovalDecision, ApprovalView } from "./types.js";

export type ApprovalExtensionOptions = {
	config: ApprovalConfig;
	requestedBy(): string | undefined;
	request(view: ApprovalView): Promise<ApprovalDecision>;
};

const DEFAULT_APPROVAL_TOOLS = ["bash", "edit", "write"];

export function createApprovalExtension(options: ApprovalExtensionOptions): ExtensionFactory {
	const tools = new Set(options.config.tools ?? DEFAULT_APPROVAL_TOOLS);
	return (pi) => {
		pi.on("tool_call", async (event) => {
			if (!tools.has(event.toolName)) return undefined;
			const view = approvalViewForTool(event, options.requestedBy(), options.config);
			const decision = await options.request(view);
			if (decision.approved) return undefined;
			return {
				block: true,
				reason: decision.reason ?? `${event.toolName} was not approved`,
			};
		});
	};
}

function approvalViewForTool(
	event: ToolCallEvent,
	requestedBy: string | undefined,
	config: ApprovalConfig,
): ApprovalView {
	const command = event.toolName === "bash" ? stringInput(event.input, "command") : undefined;
	return {
		id: event.toolCallId,
		showId: config.layout === "card",
		reason: `Run ${event.toolName} tool.`,
		detailLabel: command ? undefined : "Input",
		detail: command ? undefined : JSON.stringify(event.input),
		command,
		requestedBy,
	};
}

function stringInput(input: Record<string, unknown>, key: string): string | undefined {
	const value = input[key];
	return typeof value === "string" ? value : undefined;
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
