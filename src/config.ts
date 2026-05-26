import { existsSync, readFileSync, statSync } from "node:fs";
import { basename, resolve } from "node:path";
import type {
	BashOptions,
	CommandName,
	CustomCommand,
	IFileSystem,
	InitialFiles,
	JavaScriptConfig,
	NetworkConfig,
} from "just-bash";
import type { AdminConfig } from "./admin/index.js";
import type { Logger } from "./core/log.js";
import type { AppMessagesConfig } from "./core/messages.js";
import type { SchedulerConfig } from "./core/scheduler.js";
import type { AgentToolDefinition } from "./core-tools.js";
import type { AttachmentProcessingConfig, AttachmentStore } from "./io/attachments.js";
import type { Adapter } from "./io/handler.js";
import type { RuntimeName } from "./runtime/types.js";
import type { Store } from "./store/types.js";

export type { AdminConfig } from "./admin/index.js";

export type ModelConfig = {
	provider: string;
	name: string;
	verbosity?: "low" | "medium" | "high";
};

export type AgentContextInput = {
	provider: string;
	channel: string;
	channelName?: string;
	actor: string;
	actorName?: string;
	thread?: string;
	threadName?: string;
	threadId: string;
	turnId?: string;
	inputMessageId?: string;
	trace?: string;
};

export type AgentContextBlock =
	| string
	| {
			title?: string;
			text: string;
	  };

export type AgentContextProvider = (
	input: AgentContextInput,
) => AgentContextBlock | undefined | null | false | Promise<AgentContextBlock | undefined | null | false>;

export type AgentConfig = {
	id: string;
	model: ModelConfig;
	directory: string;
	systemPrompt?: string;
	soul?: string;
	prompt?: string;
	context?: AgentContextProvider[];
	skills?: string[];
	extensions?: string[];
	tools?: AgentToolDefinition[];
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
	docker?: DockerConfig;
	hostEnv?: Record<string, string>;
};

export type DockerConfig = {
	image?: string;
	network?: "none" | "host" | "bridge" | string;
	env?: Record<string, string>;
	args?: string[];
	user?: string | false;
};

export type AttachmentConfig = {
	store?: AttachmentStore;
	maxBytes?: number;
	process?: AttachmentProcessingConfig;
};

export type ApprovalConfig = {
	approvers?: string[];
	expiresInMs?: number;
};

export type BusyBehavior = "reject" | "followUp" | "steer";

export type ChatConfig = {
	busy?: BusyBehavior;
};

export type Scope = "channel" | "user" | "adapter" | "agent";

export type MemoryWritePolicy = "auto" | "approvers" | "off";

export type MemoryConfig =
	| boolean
	| {
			enabled?: boolean;
			scope?: Scope;
			writePolicy?: MemoryWritePolicy;
			maxChars?: number;
	  };

export type AppLockConfig = {
	ttlMs?: number;
	drainMs?: number;
};

export type HttpConfig = {
	host?: string;
	port?: number | string;
};

export type HeypiConfig = {
	store?: Store;
	adapters: Adapter[];
	agent: AgentConfig;
	runtime: RuntimeConfig;
	http?: HttpConfig;
	admin?: boolean | AdminConfig;
	attachments?: AttachmentConfig;
	approval?: ApprovalConfig;
	chat?: ChatConfig;
	scope?: Scope;
	memory?: MemoryConfig;
	messages?: AppMessagesConfig;
	appLock?: false | AppLockConfig;
	scheduler?: Omit<SchedulerConfig, "jobs">;
	jobs?: SchedulerConfig["jobs"];
	logger?: Logger;
};

export type AgentFromOptions = Partial<Omit<AgentConfig, "directory" | "model">> & {
	model?: string | ModelConfig;
};

export const DEFAULT_SOUL = [
	"You are a concise, practical assistant.",
	"Answer directly and accurately. Say when you are uncertain or blocked.",
	"Use plain language and keep responses focused on the user's goal.",
].join("\n");

/** Loads an agent from a folder convention: SOUL.md, AGENTS.md, SYSTEM.md, skills/, extensions/. */
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
		soul: options.soul ?? readIfFile(resolve(directory, "SOUL.md")) ?? DEFAULT_SOUL,
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
