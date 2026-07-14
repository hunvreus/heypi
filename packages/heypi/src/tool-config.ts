import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import type { AgentConfig, ApprovalPolicy, ToolEntry } from "./types.js";

export type ToolSettings = {
	excludeTools?: string[];
	customTools: ToolDefinition[];
	approvalPolicies: Record<string, ApprovalPolicy | false | undefined>;
};

function isToolImplementation(entry: ToolEntry): entry is ToolDefinition {
	return (
		typeof entry === "object" &&
		entry !== null &&
		"name" in entry &&
		"description" in entry &&
		"parameters" in entry &&
		"execute" in entry &&
		typeof entry.name === "string" &&
		typeof entry.description === "string" &&
		typeof entry.execute === "function"
	);
}

function isToolConfig(entry: ToolEntry): entry is { approve?: ApprovalPolicy | false } {
	if (typeof entry !== "object" || entry === null) return false;
	const keys = Object.keys(entry);
	return keys.every((key) => key === "approve");
}

export function toolSettings(agent: AgentConfig): ToolSettings {
	const exclude = new Set<string>();
	const customTools: ToolDefinition[] = [];
	const approvalPolicies: ToolSettings["approvalPolicies"] = {};
	for (const [name, entry] of Object.entries(agent.tools ?? {})) {
		if (entry === undefined) continue;
		if (entry === false) {
			exclude.add(name);
			continue;
		}
		if (isToolImplementation(entry)) {
			customTools.push(entry);
			continue;
		}
		if (!isToolConfig(entry)) {
			throw new Error(
				`Invalid tools.${name}: expected false, a ToolDefinition, or { approve }. Tool definitions require name, description, parameters, and execute.`,
			);
		}
		const config = entry;
		if (config.approve) approvalPolicies[name] = config.approve;
	}
	return {
		excludeTools: exclude.size ? [...exclude].sort() : undefined,
		customTools,
		approvalPolicies,
	};
}
