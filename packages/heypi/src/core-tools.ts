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

export type DefaultToolDefinition = {
	readonly [DEFAULT_TOOL]: true;
	readonly name: DefaultToolName;
	readonly confirm?: Confirm;
};

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

function isDefaultTool(input: unknown): input is DefaultToolDefinition {
	return Boolean(input && typeof input === "object" && (input as { [DEFAULT_TOOL]?: unknown })[DEFAULT_TOOL]);
}

export function assertAuthoredTools(input: readonly unknown[] | undefined): void {
	for (const tool of input ?? []) {
		if (isDefaultTool(tool))
			throw new Error("defaultTools() entries must be configured with builtinTools, not tools");
	}
}

export function splitTools(
	input: ToolDefinition[] | undefined,
	builtinInput?: DefaultToolDefinition[],
): {
	core: DefaultToolDefinition[];
	custom: ToolDefinition[];
} {
	const tools = input ?? [];
	const core: DefaultToolDefinition[] = [...(builtinInput ?? defaultTools())];
	const custom: ToolDefinition[] = [];
	assertAuthoredTools(tools);
	for (const tool of tools) {
		validateToolName(tool);
		custom.push(tool);
	}
	return { core, custom };
}
