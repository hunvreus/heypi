import {
	type AgentSession,
	AuthStorage,
	createAgentSession,
	DefaultResourceLoader,
	ModelRegistry,
	type ResourceLoader,
	SessionManager,
	SettingsManager,
} from "@mariozechner/pi-coding-agent";
import type { AgentConfig } from "../config.js";
import type { CallRunner } from "../core/calls.js";
import { type Logger, logError, logger, redact, userError } from "../core/log.js";
import type { ReplyStream } from "../io/reply-stream.js";
import type { Messages, Sessions, StoredMessage } from "../store/types.js";
import type { Agent, AgentReq, AgentRes } from "./agent.js";
import { tools } from "./tools.js";
import type { Runtime } from "./types.js";

const DEFAULT_SYSTEM = [
	"You are a concise team assistant.",
	"Use available tools when they are needed to answer or act.",
	"If approval is required, tell the user how to approve or deny the action.",
	"Keep responses short, accurate, and task-focused.",
].join("\n");

export type PiAgentInput = {
	agent: AgentConfig;
	callRunner: CallRunner;
	runtime: Runtime;
	messages: Messages;
	sessions: Sessions;
	logger?: Logger;
};

export class PiAgent implements Agent {
	constructor(private readonly input: PiAgentInput) {}

	async ask(req: AgentReq): Promise<AgentRes> {
		const history = await this.input.sessions.load(req.threadId, req.inputMessageId);
		const session = await this.create(req.channel, req.actor, history, {
			trace: req.trace,
			agent: this.input.agent.id,
			thread: req.threadId,
			turn: req.turnId,
			message: req.inputMessageId,
			model: req.model,
		});
		return await this.run({ mode: "prompt", session, generatedAt: history.length + 1, req });
	}

	async continue(req: Omit<AgentReq, "text" | "inputMessageId">): Promise<AgentRes> {
		const history = await this.input.sessions.load(req.threadId);
		const session = await this.create(req.channel, req.actor, history, {
			trace: req.trace,
			agent: this.input.agent.id,
			thread: req.threadId,
			turn: req.turnId,
			model: req.model,
		});
		return await this.run({ mode: "continue", session, generatedAt: history.length, req: { ...req, text: "" } });
	}

	private async run(input: {
		mode: "prompt" | "continue";
		session: AgentSession;
		generatedAt: number;
		req: AgentReq;
	}): Promise<AgentRes> {
		const { mode, session, generatedAt, req } = input;
		const log = this.input.logger ?? logger;
		log.debug("agent.start", {
			agent: this.input.agent.id,
			trace: req.trace,
			channel: req.channel,
			thread: req.threadId,
			turn: req.turnId,
			message: req.inputMessageId,
			actor: req.actor,
			history: generatedAt,
			tools: session.getActiveToolNames().join(","),
		});
		let out = "";
		const unsub = session.subscribe((event) => {
			if (event.type === "tool_execution_start") {
				log.debug("tool.start", {
					agent: this.input.agent.id,
					trace: req.trace,
					channel: req.channel,
					thread: req.threadId,
					turn: req.turnId,
					message: req.inputMessageId,
					actor: req.actor,
					tool: event.toolName,
				});
			}
			if (event.type === "tool_execution_end") {
				log.debug("tool.end", {
					agent: this.input.agent.id,
					trace: req.trace,
					channel: req.channel,
					thread: req.threadId,
					turn: req.turnId,
					message: req.inputMessageId,
					actor: req.actor,
					tool: event.toolName,
				});
			}
			if (event.type === "message_update" && event.assistantMessageEvent.type === "text_delta")
				out = streamTextDelta({
					current: out,
					delta: event.assistantMessageEvent.delta,
					stream: req.stream,
					logger: log,
					context: {
						agent: this.input.agent.id,
						trace: req.trace,
						channel: req.channel,
						thread: req.threadId,
						turn: req.turnId,
					},
				});
		});
		const abort = () => {
			void session.abort().catch((error) => {
				log.warn("agent.abort_failed", {
					agent: this.input.agent.id,
					trace: req.trace,
					channel: req.channel,
					thread: req.threadId,
					turn: req.turnId,
					error: error instanceof Error ? error.message : String(error),
				});
			});
		};
		if (req.signal?.aborted) abort();
		else req.signal?.addEventListener("abort", abort, { once: true });
		try {
			if (mode === "continue") await session.agent.continue();
			else await session.prompt(req.text, { expandPromptTemplates: false });
		} finally {
			req.signal?.removeEventListener("abort", abort);
			unsub();
		}
		if (req.signal?.aborted) return { text: "cancelled" };
		const error = lastAssistantError(session);
		if (error) {
			logError(log, "model", {
				agent: this.input.agent.id,
				trace: req.trace,
				channel: req.channel,
				thread: req.threadId,
				turn: req.turnId,
				message: req.inputMessageId,
				actor: req.actor,
				error,
			});
			return { text: userError("model") };
		}
		if (!out.trim()) out = lastAssistantText(session);
		const messages = session.messages.slice(generatedAt) as StoredMessage[];
		if (!out.trim()) out = lastText(messages);
		if (!out.trim()) {
			logError(log, "model", {
				agent: this.input.agent.id,
				trace: req.trace,
				channel: req.channel,
				thread: req.threadId,
				turn: req.turnId,
				message: req.inputMessageId,
				actor: req.actor,
				error: "empty model response",
			});
			return { text: userError("model") };
		}
		const text = out.trim();
		const silent = silentReply(text);
		log.debug("agent.end", {
			agent: this.input.agent.id,
			trace: req.trace,
			channel: req.channel,
			thread: req.threadId,
			turn: req.turnId,
			message: req.inputMessageId,
			actor: req.actor,
			chars: text.length,
		});
		return { text: silent ? "" : text, silent, messages };
	}

	private async create(
		channel: string,
		actor: string,
		history: StoredMessage[],
		context: {
			trace?: string;
			agent: string;
			thread: string;
			turn?: string;
			message?: string;
			model?: AgentReq["model"];
		},
	): Promise<AgentSession> {
		const agent = this.input.agent;
		const modelConfig = context.model ?? agent.model;
		const log = this.input.logger ?? logger;
		const settings = SettingsManager.inMemory({
			defaultProvider: modelConfig.provider,
			defaultModel: modelConfig.name,
			enableSkillCommands: false,
		});
		const auth = AuthStorage.create();
		const models = ModelRegistry.inMemory(auth);
		const model = models.find(modelConfig.provider, modelConfig.name);
		if (!model) throw new Error(`unknown model: ${modelConfig.provider}/${modelConfig.name}`);
		const loader = await resourceLoader(agent, settings, log);
		const customTools = tools({
			runtime: this.input.runtime,
			callRunner: this.input.callRunner,
			messages: this.input.messages,
			channel,
			actor,
			context,
			custom: agent.tools,
			logger: log,
		});
		const activeTools = [...extensionToolNames(loader), ...customTools.map((tool) => tool.name)];

		const { session, modelFallbackMessage } = await createAgentSession({
			cwd: agent.directory,
			resourceLoader: loader,
			settingsManager: settings,
			authStorage: auth,
			modelRegistry: models,
			model,
			tools: activeTools,
			sessionManager: SessionManager.inMemory(),
			customTools,
		});
		if (modelFallbackMessage) throw new Error(modelFallbackMessage);
		session.setActiveToolsByName(activeTools);
		session.state.messages = history;
		return session;
	}
}

async function resourceLoader(agent: AgentConfig, settings: SettingsManager, _log: Logger): Promise<ResourceLoader> {
	const loader = new DefaultResourceLoader({
		cwd: agent.directory,
		agentDir: agent.directory,
		settingsManager: settings,
		noExtensions: true,
		noSkills: true,
		noPromptTemplates: true,
		additionalExtensionPaths: agent.extensions ?? [],
		additionalSkillPaths: agent.skills ?? [],
		systemPromptOverride: () => agent.systemPrompt ?? DEFAULT_SYSTEM,
		appendSystemPromptOverride: () => (agent.prompt ? [agent.prompt] : []),
		agentsFilesOverride: () => ({ agentsFiles: [] }),
	});
	await loader.reload();
	return loader;
}

function extensionToolNames(loader: ResourceLoader): string[] {
	return loader.getExtensions().extensions.flatMap((extension) => [...extension.tools.keys()]);
}

function lastAssistantText(session: AgentSession): string {
	const last = [...session.messages].reverse().find((message) => message.role === "assistant");
	if (!last?.content) return "";
	if (typeof last.content === "string") return last.content;
	return last.content
		.filter((part): part is { type: "text"; text: string } => part.type === "text")
		.map((part) => part.text)
		.join("\n");
}

function lastAssistantError(session: AgentSession): string | undefined {
	const last = [...session.messages].reverse().find((message) => message.role === "assistant");
	if (!last || !("errorMessage" in last)) return undefined;
	const error = last.errorMessage;
	return typeof error === "string" && error.trim() ? error : undefined;
}

function lastText(messages: StoredMessage[]): string {
	for (const message of [...messages].reverse()) {
		if (!("content" in message)) continue;
		if (typeof message.content === "string") return message.content;
		if (!Array.isArray(message.content)) continue;
		const text = message.content
			.map((part) => (part.type === "text" ? part.text : ""))
			.filter(Boolean)
			.join("\n");
		if (text.trim()) return text;
	}
	return "";
}

function silentReply(text: string): boolean {
	return text.trim() === "[SILENT]";
}

export function streamTextDelta(input: {
	current: string;
	delta: string;
	stream?: ReplyStream;
	logger: Pick<Logger, "warn">;
	context: Record<string, unknown>;
}): string {
	const out = input.current + input.delta;
	void input.stream?.update(redact(out)).catch((error) => {
		input.logger.warn("agent.stream_failed", {
			...input.context,
			error: error instanceof Error ? error.message : String(error),
		});
	});
	return out;
}
