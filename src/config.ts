import { existsSync, readFileSync, statSync } from "node:fs";
import { basename, resolve } from "node:path";
import type { ToolDefinition } from "@mariozechner/pi-coding-agent";
import type {
	BashOptions,
	CommandName,
	CustomCommand,
	IFileSystem,
	InitialFiles,
	JavaScriptConfig,
	NetworkConfig,
} from "just-bash";
import type { Logger } from "./core/log.js";
import type { SchedulerConfig } from "./core/scheduler.js";
import type { AttachmentStore } from "./io/attachments.js";
import type { Adapter } from "./io/handler.js";
import type { RuntimeName } from "./runtime/types.js";
import type { Store } from "./store/types.js";

export type ModelConfig = {
	provider: string;
	name: string;
};

export type AgentConfig = {
	id: string;
	model: ModelConfig;
	directory: string;
	systemPrompt?: string;
	prompt?: string;
	skills?: string[];
	extensions?: string[];
	tools?: ToolDefinition[];
};

export type JustBashConfig = {
	filesystem?: IFileSystem;
	files?: InitialFiles;
	env?: Record<string, string>;
	commands?: CommandName[];
	customCommands?: CustomCommand[];
	network?: NetworkConfig;
	python?: boolean;
	javascript?: boolean | JavaScriptConfig;
	defenseInDepth?: BashOptions["defenseInDepth"];
};

export type RuntimeLimits = {
	maxFileBytes?: number;
	maxScanBytes?: number;
	maxEntries?: number;
};

export type RuntimeConfig = {
	name?: RuntimeName;
	root: string;
	timeoutMs?: number;
	maxConcurrent?: number;
	maxConcurrentPerChat?: number;
	limits?: RuntimeLimits;
	justBash?: JustBashConfig;
	hostEnv?: Record<string, string>;
};

export type AttachmentConfig = {
	maxBytes?: number;
};

export type ApprovalConfig = {
	approvers?: string[];
	expiresInMs?: number;
};

export type HeypiConfig = {
	store: Store;
	adapters: Adapter[];
	agent: AgentConfig;
	runtime: RuntimeConfig;
	attachments?: AttachmentStore;
	attachment?: AttachmentConfig;
	approval?: ApprovalConfig;
	scheduler?: Omit<SchedulerConfig, "jobs">;
	jobs?: SchedulerConfig["jobs"];
	logger?: Logger;
};

export type AgentFromOptions = Partial<Omit<AgentConfig, "directory" | "model">> & {
	model?: string | ModelConfig;
};

/** Loads an agent from a folder convention: SYSTEM.md, AGENTS.md, skills/, extensions/. */
export function agentFrom(folder = ".", options: AgentFromOptions = {}): AgentConfig {
	const directory = resolve(folder);
	const id = options.id ?? basename(directory) ?? "agent";
	const selectedModel = options.model ?? process.env.HEYPI_MODEL;
	if (!selectedModel) throw new Error("agent model is required; pass agentFrom(..., { model }) or set HEYPI_MODEL");
	const model = modelConfig(selectedModel);
	return {
		id,
		model,
		directory,
		systemPrompt: options.systemPrompt ?? readIfFile(resolve(directory, "SYSTEM.md")),
		prompt: options.prompt ?? readIfFile(resolve(directory, "AGENTS.md")),
		skills: options.skills ?? dirList(resolve(directory, "skills")),
		extensions: options.extensions ?? dirList(resolve(directory, "extensions")),
		tools: options.tools,
	};
}

export function modelConfig(input: string | ModelConfig): ModelConfig {
	if (typeof input !== "string") return input;
	const slash = input.indexOf("/");
	if (slash <= 0 || slash === input.length - 1) throw new Error(`model must use provider/name form: ${input}`);
	return { provider: input.slice(0, slash), name: input.slice(slash + 1) };
}

function readIfFile(path: string): string | undefined {
	if (!existsSync(path)) return undefined;
	const stat = statSync(path);
	if (!stat.isFile()) return undefined;
	return readFileSync(path, "utf8").trim();
}

function dirList(path: string): string[] {
	if (!existsSync(path)) return [];
	const stat = statSync(path);
	return stat.isDirectory() ? [path] : [];
}
