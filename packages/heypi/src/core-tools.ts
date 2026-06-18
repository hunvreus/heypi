import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import { approval } from "./approval.js";
import type { Confirm } from "./core/types.js";
import { validateToolName } from "./tool.js";

const DEFAULT_TOOL = Symbol("default-tool");

export type DefaultToolName = "history" | "bash" | "read" | "write" | "edit" | "grep" | "find" | "ls" | "attach";

export type DefaultToolConfig = {
	confirm?: Confirm;
};

export type DefaultToolOption = boolean | DefaultToolConfig;

export type DefaultToolsConfig = Partial<Record<DefaultToolName, DefaultToolOption>>;

/** @deprecated Use `DefaultToolName` instead. */
export type CoreToolName = DefaultToolName;

/** @deprecated Use `DefaultToolConfig` instead. */
export type CoreToolConfig = DefaultToolConfig;

/** @deprecated Use `DefaultToolOption` instead. */
export type CoreToolOption = DefaultToolOption;

/** @deprecated Use `DefaultToolsConfig` instead. */
export type CoreToolsConfig = DefaultToolsConfig;

export type DefaultToolDefinition = {
	readonly [DEFAULT_TOOL]: true;
	readonly name: DefaultToolName;
	readonly confirm?: Confirm;
};

/** @deprecated Use `DefaultToolDefinition` instead. */
export type CoreToolDefinition = DefaultToolDefinition;

export type AgentToolDefinition = ToolDefinition | DefaultToolDefinition;

const DEFAULT_CORE: Required<DefaultToolsConfig> = {
	history: true,
	bash: { confirm: approval.command() },
	read: true,
	write: true,
	edit: true,
	grep: true,
	find: true,
	ls: true,
	attach: true,
};

/** Returns heypi's default runtime tools, including approval-gated bash by default. */
export function defaultTools(config: DefaultToolsConfig = {}): DefaultToolDefinition[] {
	const merged = { ...DEFAULT_CORE, ...config };
	const out: DefaultToolDefinition[] = [];
	for (const name of Object.keys(DEFAULT_CORE) as DefaultToolName[]) {
		const option = merged[name];
		if (option === false) continue;
		out.push({
			[DEFAULT_TOOL]: true,
			name,
			confirm: typeof option === "object" ? option.confirm : undefined,
		});
	}
	return out;
}

/** @deprecated Use `defaultTools()` instead. */
export const coreTools = defaultTools;

function isDefaultTool(input: unknown): input is DefaultToolDefinition {
	return Boolean(input && typeof input === "object" && (input as { [DEFAULT_TOOL]?: unknown })[DEFAULT_TOOL]);
}

export function splitTools(input: AgentToolDefinition[] | undefined): {
	core: DefaultToolDefinition[];
	custom: ToolDefinition[];
} {
	const tools = input ?? defaultTools();
	const core: DefaultToolDefinition[] = [];
	const custom: ToolDefinition[] = [];
	for (const tool of tools) {
		if (isDefaultTool(tool)) core.push(tool);
		else {
			validateToolName(tool);
			custom.push(tool);
		}
	}
	return { core, custom };
}
