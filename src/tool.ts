import type { ToolDefinition } from "@mariozechner/pi-coding-agent";
import type { Confirm } from "./core/types.js";
import { type ConfirmableToolDefinition, TOOL_EXECUTE } from "./tool-internal.js";

export type ToolParams = Record<string, unknown>;
export type ToolResult = string | Awaited<ReturnType<ToolDefinition["execute"]>>;

export type Tool<T extends ToolParams = ToolParams> = {
	name: string;
	description: string;
	parameters: ToolDefinition["parameters"];
	label?: string;
	confirm?: Confirm;
	execute(input: T, signal?: AbortSignal): ToolResult | Promise<ToolResult>;
};

/** Creates a heypi custom tool while keeping raw Pi tools supported. */
export function tool<T extends ToolParams = ToolParams>(input: Tool<T>): ToolDefinition {
	const execute = async (params: Record<string, unknown>, signal?: AbortSignal): Promise<{ out: string }> => {
		const result = await input.execute(params as T, signal);
		return { out: resultText(result) };
	};
	const out: ConfirmableToolDefinition = {
		name: input.name,
		label: input.label ?? input.name,
		description: input.description,
		parameters: input.parameters,
		confirm: input.confirm,
		[TOOL_EXECUTE]: execute,
		async execute(_toolCallId, params, signal) {
			const result = await input.execute(params as T, signal);
			if (typeof result !== "string") return result;
			return {
				content: [{ type: "text", text: result }],
				details: { tool: input.name },
			};
		},
	};
	return out;
}

function resultText(result: ToolResult): string {
	if (typeof result === "string") return result;
	return (result.content ?? [])
		.map((item) => (item.type === "text" ? item.text : ""))
		.filter(Boolean)
		.join("\n");
}
