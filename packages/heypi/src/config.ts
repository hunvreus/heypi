import { existsSync, readFileSync, statSync } from "node:fs";
import { resolve } from "node:path";
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
import type { ActorPolicy } from "./core/approvers.js";
import type { Logger } from "./core/log.js";
import type { AppMessagesConfig } from "./core/messages.js";
import type { SchedulerConfig } from "./core/scheduler.js";
import type { AgentToolDefinition } from "./core-tools.js";
import type { EvalConfig } from "./eval.js";
import type { AttachmentProcessingConfig, AttachmentStore } from "./io/attachments.js";
import type { Adapter } from "./io/handler.js";
import type { JobConfig } from "./job.js";
import { loadEvals, loadJobs, loadTools } from "./load.js";
import type { RuntimeName, RuntimeProvider } from "./runtime/types.js";
import type { StateConfig } from "./state.js";
import type { Store } from "./store/types.js";

export type { AdminConfig } from "./admin/index.js";
export type { StateConfig } from "./state.js";

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
	jobs?: JobConfig[];
	evals?: EvalConfig[];
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
	provider?: RuntimeProvider;
	root: string;
	scope?: Scope;
	timeoutMs?: number;
	maxConcurrent?: number;
	maxConcurrentPerChat?: number;
	limits?: RuntimeLimits;
	justBash?: JustBashConfig;
	hostEnv?: Record<string, string>;
};

export type AttachmentConfig = {
	store?: AttachmentStore;
	maxBytes?: number;
	process?: AttachmentProcessingConfig;
};

export type ApprovalConfig = {
	expiresInMs?: number;
	allowSelfApproval?: boolean;
	bypass?: false | ApprovalBypassConfig;
};

export type ApprovalBypassScope = "thread" | "channel" | "user" | "adapter";

export type ApprovalBypassConfig = {
	durationMs?: number;
	maxDurationMs?: number;
	scope?: ApprovalBypassScope;
};

export type PermissionsConfig = {
	approvers?: ActorPolicy;
	admins?: ActorPolicy;
};

export type ApprovalPolicy = ApprovalConfig & PermissionsConfig;

export type BusyBehavior = "reject" | "followUp" | "steer";
export type CancelPolicy = "admin" | "approver" | "initiator" | "allowed";

export type TaskConfig = {
	busy?: BusyBehavior;
	cancel?: CancelPolicy;
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

export type SkillWritePolicy = "auto" | "approvers" | "off";

export type SkillsConfig =
	| boolean
	| {
			enabled?: boolean;
			scope?: Scope;
			writePolicy?: SkillWritePolicy;
			maxSkills?: number;
			maxChars?: number;
	  };

export type SecretsConfig =
	| boolean
	| {
			enabled?: boolean;
			url?: string;
			serve?: boolean;
			expiresInMs?: number;
			maxFields?: number;
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
	state: StateConfig;
	adapters: Adapter[];
	agent: AgentConfig;
	runtime: RuntimeConfig;
	http?: HttpConfig;
	admin?: boolean | AdminConfig;
	attachments?: AttachmentConfig;
	approval?: ApprovalConfig;
	task?: TaskConfig;
	scope?: Scope;
	memory?: MemoryConfig;
	skills?: SkillsConfig;
	secrets?: SecretsConfig;
	messages?: AppMessagesConfig;
	appLock?: false | AppLockConfig;
	scheduler?: Omit<SchedulerConfig, "jobs">;
	jobs?: SchedulerConfig["jobs"];
	logger?: Logger;
};

export type LoadAgentOptions = Partial<Omit<AgentConfig, "directory" | "model">> & {
	model?: string | ModelConfig;
};

export const DEFAULT_SOUL = [
	"You are a concise, practical assistant.",
	"Answer directly and accurately. Say when you are uncertain or blocked.",
	"Use plain language and keep responses focused on the user's goal.",
].join("\n");

export const DEFAULT_AGENT_ID = "default";

/** Loads an agent from the heypi folder convention, including prompts, tools, jobs, evals, skills, and extensions. */
export function loadAgent(folder = ".", options: LoadAgentOptions = {}): AgentConfig {
	const directory = resolve(folder);
	const id = options.id ?? DEFAULT_AGENT_ID;
	const selectedModel = options.model ?? process.env.HEYPI_MODEL;
	if (!selectedModel) throw new Error("agent model is required; pass loadAgent(..., { model }) or set HEYPI_MODEL");
	const model = modelConfig(selectedModel);
	const discoveredTools = loadTools(resolve(directory, "tools"));
	const explicitTools = options.tools ?? [];
	const tools = mergeTools(explicitTools, discoveredTools);
	const jobs = mergeJobs(options.jobs ?? [], loadJobs(resolve(directory, "jobs")));
	const evals = mergeEvals(options.evals ?? [], loadEvals(resolve(directory, "evals")));
	return {
		id,
		model,
		directory,
		systemPrompt: options.systemPrompt ?? readIfFile(resolve(directory, "SYSTEM.md")),
		soul: options.soul ?? readIfFile(resolve(directory, "SOUL.md")) ?? DEFAULT_SOUL,
		prompt: options.prompt ?? readIfFile(resolve(directory, "AGENTS.md")),
		context: options.context,
		skills: options.skills ?? dirList(resolve(directory, "skills")),
		extensions: options.extensions ?? dirList(resolve(directory, "extensions")),
		tools,
		jobs,
		evals,
	};
}

/** @deprecated Use `loadAgent()` instead. */
export const agentFrom = loadAgent;

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

function mergeTools(
	explicit: AgentToolDefinition[],
	discovered: AgentToolDefinition[],
): AgentToolDefinition[] | undefined {
	if (!explicit.length && !discovered.length) return undefined;
	const seen = new Set<string>();
	for (const tool of explicit) {
		if ("name" in tool) seen.add(tool.name);
	}
	for (const tool of discovered) {
		if ("name" in tool && seen.has(tool.name))
			throw new Error(`duplicate tool name "${tool.name}" in config and discovery`);
		if ("name" in tool) seen.add(tool.name);
	}
	return [...explicit, ...discovered];
}

function mergeJobs(explicit: JobConfig[], discovered: JobConfig[]): JobConfig[] | undefined {
	if (!explicit.length && !discovered.length) return undefined;
	const seen = new Set<string>();
	for (const job of explicit) seen.add(job.id);
	for (const job of discovered) {
		if (seen.has(job.id)) throw new Error(`duplicate job id "${job.id}" in config and discovery`);
		seen.add(job.id);
	}
	return [...explicit, ...discovered];
}

function mergeEvals(explicit: EvalConfig[], discovered: EvalConfig[]): EvalConfig[] | undefined {
	if (!explicit.length && !discovered.length) return undefined;
	const seen = new Set<string>();
	for (const evaluation of explicit) seen.add(evaluation.name);
	for (const evaluation of discovered) {
		if (seen.has(evaluation.name))
			throw new Error(`duplicate eval name "${evaluation.name}" in config and discovery`);
		seen.add(evaluation.name);
	}
	return [...explicit, ...discovered];
}
