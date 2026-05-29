import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import { textContent } from "./core/content.js";
import type { Confirm, ToolExecutionContext } from "./core/types.js";
import { type ConfirmableToolDefinition, TOOL_EXECUTE, TOOL_PI_EXECUTE } from "./tool-internal.js";

export type ToolParams = Record<string, unknown>;
export type ToolResult = string | Awaited<ReturnType<ToolDefinition["execute"]>>;
export type ToolContext = ToolExecutionContext;

export type Tool<T extends ToolParams = ToolParams> = {
	name: string;
	description: string;
	parameters: ToolDefinition["parameters"];
	label?: string;
	confirm?: Confirm;
	execute(input: T, context: ToolContext): ToolResult | Promise<ToolResult>;
};

/** Creates a heypi custom tool while keeping raw Pi tools supported. */
export function tool<T extends ToolParams = ToolParams>(input: Tool<T>): ToolDefinition {
	const execute = async (params: Record<string, unknown>, context: ToolContext): Promise<{ out: string }> => {
		const result = await input.execute(params as T, context);
		return { out: resultText(result) };
	};
	const executePi = async (
		params: Record<string, unknown>,
		context: ToolContext,
	): Promise<Awaited<ReturnType<ToolDefinition["execute"]>>> => {
		const result = await input.execute(params as T, context);
		return piResult(input.name, result);
	};
	const out: ConfirmableToolDefinition = {
		name: input.name,
		label: input.label ?? input.name,
		description: input.description,
		parameters: input.parameters,
		confirm: input.confirm,
		[TOOL_EXECUTE]: execute,
		[TOOL_PI_EXECUTE]: executePi,
		async execute(_toolCallId, params, signal) {
			return executePi(params as Record<string, unknown>, {
				runtime: { name: "unbound", root: "" },
				signal,
			});
		},
	};
	return out;
}

function piResult(name: string, result: ToolResult): Awaited<ReturnType<ToolDefinition["execute"]>> {
	if (typeof result !== "string") return result;
	return {
		content: [{ type: "text", text: result }],
		details: { tool: name },
	};
}

function resultText(result: ToolResult): string {
	if (typeof result === "string") return result;
	return textContent(result.content);
}
