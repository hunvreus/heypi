import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import { toJSONSchema, type ZodType, type z } from "zod";
import { textContent } from "./core/content.js";
import type { Confirm, ToolExecutionContext } from "./core/types.js";
import type { Runtime } from "./runtime/types.js";
import { type ConfirmableToolDefinition, TOOL_EXECUTE, TOOL_PI_EXECUTE } from "./tool-internal.js";

const INFERRED_TOOL_NAME = Symbol.for("@hunvreus/heypi/inferred-tool-name");

export type ToolParams = Record<string, unknown>;
export type ToolResult = string | Awaited<ReturnType<ToolDefinition["execute"]>>;
export type ToolContext = ToolExecutionContext;
export type ToolSchema = ToolDefinition["parameters"] | ZodType;

type ToolInput<T extends ToolParams = ToolParams> = {
	name: string;
	description: string;
	parameters: ToolDefinition["parameters"];
	label?: string;
	confirm?: Confirm;
	execute(input: T, context: ToolContext): ToolResult | Promise<ToolResult>;
};

export type DefineTool<T extends ToolParams = ToolParams, TSchema extends ToolSchema = ToolDefinition["parameters"]> = {
	name?: string;
	description: string;
	input: TSchema;
	label?: string;
	confirm?: Confirm;
	run(input: T, context: ToolContext): ToolResult | Promise<ToolResult>;
};

type DefineZodTool<TSchema extends ZodType> = DefineTool<z.output<TSchema> & ToolParams, TSchema>;

/** Defines a trusted heypi custom tool from an input schema and run handler. */
export function defineTool<T extends ToolParams = ToolParams>(
	input: DefineTool<T, ToolDefinition["parameters"]>,
): ToolDefinition;
export function defineTool<TSchema extends ZodType>(input: DefineZodTool<TSchema>): ToolDefinition;
export function defineTool(input: DefineTool<ToolParams, ToolSchema>): ToolDefinition {
	const parser = inputParser(input.input);
	return createTool({
		name: input.name ?? "",
		description: input.description,
		parameters: normalizeSchema(input.input),
		label: input.label,
		confirm: parseConfirm(input.confirm, parser),
		execute: (params, context) => input.run(parser(params), context),
	});
}

function createTool<T extends ToolParams = ToolParams>(input: ToolInput<T>): ToolDefinition {
	const inferredName = !input.name;
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
		async execute(toolCallId, params, signal) {
			void toolCallId;
			return executePi(params as Record<string, unknown>, {
				runtime: unboundRuntime,
				signal,
			});
		},
	};
	if (inferredName) markInferredToolName(out);
	return out;
}

export function assignDiscoveredToolName(tool: ToolDefinition, name: string): ToolDefinition {
	if (!needsDiscoveredToolName(tool)) return tool;
	return { ...tool, name, label: (tool as ConfirmableToolDefinition).label || name };
}

export function validateToolName(tool: ToolDefinition): void {
	if (!needsDiscoveredToolName(tool)) return;
	throw new Error("tool name is required unless the tool is loaded with loadTools()");
}

function markInferredToolName(tool: ToolDefinition): void {
	Object.defineProperty(tool, INFERRED_TOOL_NAME, { value: true });
}

function needsDiscoveredToolName(tool: ToolDefinition): boolean {
	return Boolean((tool as { [INFERRED_TOOL_NAME]?: boolean })[INFERRED_TOOL_NAME]);
}

function normalizeSchema(input: ToolSchema): ToolDefinition["parameters"] {
	if (!isZodSchema(input)) return input as ToolDefinition["parameters"];
	return toJSONSchema(input) as ToolDefinition["parameters"];
}

function inputParser(input: ToolSchema): (params: Record<string, unknown>) => ToolParams {
	if (!isZodSchema(input)) return (params) => params;
	return (params) => input.parse(params) as ToolParams;
}

function parseConfirm(
	confirm: Confirm | undefined,
	parser: (params: Record<string, unknown>) => ToolParams,
): Confirm | undefined {
	if (typeof confirm !== "function") return confirm;
	return (params) => confirm(parser(params));
}

function isZodSchema(input: ToolSchema): input is ZodType {
	return Boolean(input && typeof input === "object" && "_zod" in input);
}

const unboundRuntime: Runtime = {
	name: "unbound",
	root: "",
	bash: unbound,
	read: unbound,
	write: unbound,
	edit: unbound,
	grep: unbound,
	find: unbound,
	ls: unbound,
};

function unbound(): never {
	throw new Error("runtime not bound; register this tool through heypi before using ctx.runtime");
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
