import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import { commandConfirm } from "./core/policy.js";
import type { Confirm } from "./core/types.js";

const CORE_TOOL = Symbol("core-tool");

export type CoreToolName = "history" | "bash" | "read" | "write" | "edit" | "grep" | "find" | "ls";

export type CoreToolConfig = {
	confirm?: Confirm;
};

export type CoreToolOption = boolean | CoreToolConfig;

export type CoreToolsConfig = Partial<Record<CoreToolName, CoreToolOption>>;

export type CoreToolDefinition = {
	readonly [CORE_TOOL]: true;
	readonly name: CoreToolName;
	readonly confirm?: Confirm;
};

export type AgentToolDefinition = ToolDefinition | CoreToolDefinition;

const DEFAULT_CORE: Required<CoreToolsConfig> = {
	history: true,
	bash: { confirm: commandConfirm() },
	read: true,
	write: true,
	edit: true,
	grep: true,
	find: true,
	ls: true,
};

export function coreTools(config: CoreToolsConfig = {}): CoreToolDefinition[] {
	const merged = { ...DEFAULT_CORE, ...config };
	const out: CoreToolDefinition[] = [];
	for (const name of Object.keys(DEFAULT_CORE) as CoreToolName[]) {
		const option = merged[name];
		if (option === false) continue;
		out.push({
			[CORE_TOOL]: true,
			name,
			confirm: typeof option === "object" ? option.confirm : undefined,
		});
	}
	return out;
}

export function isCoreTool(input: unknown): input is CoreToolDefinition {
	return Boolean(input && typeof input === "object" && (input as { [CORE_TOOL]?: unknown })[CORE_TOOL]);
}

export function splitTools(input: AgentToolDefinition[] | undefined): {
	core: CoreToolDefinition[];
	custom: ToolDefinition[];
} {
	const tools = input ?? coreTools();
	const core: CoreToolDefinition[] = [];
	const custom: ToolDefinition[] = [];
	for (const tool of tools) {
		if (isCoreTool(tool)) core.push(tool);
		else custom.push(tool);
	}
	return { core, custom };
}
