import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import type { Confirm, ToolExecute } from "./core/types.js";

export const TOOL_EXECUTE = Symbol("heypi.tool.execute");

export type ConfirmableToolDefinition = ToolDefinition & { confirm?: Confirm; [TOOL_EXECUTE]?: ToolExecute };

export function toolRunner(input: unknown): ToolExecute | undefined {
	if (!input || typeof input !== "object") return undefined;
	const execute = (input as { [TOOL_EXECUTE]?: unknown })[TOOL_EXECUTE];
	return typeof execute === "function" ? (execute as ToolExecute) : undefined;
}

export function toolConfirm(input: ToolDefinition): Confirm | undefined {
	return (input as ConfirmableToolDefinition).confirm;
}
