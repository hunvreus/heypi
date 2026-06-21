import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import type { Confirm, ToolExecute, ToolExecutionContext } from "./core/types.js";

export const TOOL_EXECUTE = Symbol.for("heypi.tool.execute");
export const TOOL_PI_EXECUTE = Symbol.for("heypi.tool.pi.execute");

export type ToolPiExecute = (
	args: Record<string, unknown>,
	context: ToolExecutionContext,
) => Promise<Awaited<ReturnType<ToolDefinition["execute"]>>>;

export type ConfirmableToolDefinition = ToolDefinition & {
	confirm?: Confirm;
	[TOOL_EXECUTE]?: ToolExecute;
	[TOOL_PI_EXECUTE]?: ToolPiExecute;
};

export function toolRunner(input: unknown): ToolExecute | undefined {
	if (!input || typeof input !== "object") return undefined;
	const execute = (input as { [TOOL_EXECUTE]?: unknown })[TOOL_EXECUTE];
	return typeof execute === "function" ? (execute as ToolExecute) : undefined;
}

export function toolPiRunner(input: unknown): ToolPiExecute | undefined {
	if (!input || typeof input !== "object") return undefined;
	const execute = (input as { [TOOL_PI_EXECUTE]?: unknown })[TOOL_PI_EXECUTE];
	return typeof execute === "function" ? (execute as ToolPiExecute) : undefined;
}

export function toolConfirm(input: ToolDefinition): Confirm | undefined {
	return (input as ConfirmableToolDefinition).confirm;
}
