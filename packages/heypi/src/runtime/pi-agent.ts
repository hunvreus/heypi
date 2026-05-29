import { dirname, isAbsolute, resolve } from "node:path";
import {
	type AgentSession,
	AuthStorage,
	createAgentSession,
	DefaultResourceLoader,
	ModelRegistry,
	type ResourceLoader,
	SessionManager,
	SettingsManager,
	type ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import { Type } from "@sinclair/typebox";
import type { AgentConfig, AgentContextBlock, AgentContextInput, ModelConfig } from "../config.js";
import { normalizeApprovalDetails } from "../core/approval-view.js";
import type { CallRunner } from "../core/calls.js";
import { type Logger, logError, logger, redact, userError } from "../core/log.js";
import { type MemoryStore, memoryContext } from "../core/memory.js";
import { type AppMessages, DEFAULT_APP_MESSAGES } from "../core/messages.js";
import type { ScopedKey } from "../core/scope.js";
import type { ApprovalPrompt, ToolContinuation } from "../core/types.js";
import { splitTools } from "../core-tools.js";
import { type AttachmentProcessingConfig, attachmentInput } from "../io/attachments.js";
import type { ReplyStream } from "../io/reply-stream.js";
import type { Messages, StoredMessage } from "../store/types.js";
import type { Agent, AgentReq, AgentRes } from "./agent.js";
import { stringParam } from "./tool-util.js";
import { tools } from "./tools.js";
import type { Runtime } from "./types.js";

const DEFAULT_SYSTEM = [
	"Use available tools when needed. Prefer the narrowest available tool that directly matches the task. Do not say you used a tool unless you actually called it.",
	"Approvals are handled by the runtime. Do not ask users to approve tool calls in plain text.",
].join("\n\n");

export type PiAgentInput = {
	agent: AgentConfig;
	callRunner: CallRunner;
	runtime: Runtime | ((scope?: string) => Runtime);
	sessionRuntime?: Runtime;
	attachmentRuntime?: Runtime;
	messages: Messages;
	attachments?: AttachmentProcessingConfig;
	memory?: MemoryStore;
	approvalApprovers?: string[];
	logger?: Logger;
	appMessages?: AppMessages;
};

export class PiAgent implements Agent {
	constructor(private readonly input: PiAgentInput) {}

	async ask(req: AgentReq): Promise<AgentRes> {
		const session = await this.create(req.channel, req.actor, req, {
			trace: req.trace,
			agent: this.input.agent.id,
			provider: req.provider,
			channelName: req.channelName,
			thread: req.threadId,
			providerThread: req.thread,
			threadName: req.threadName,
			turn: req.turnId,
			message: req.inputMessageId,
			actorName: req.actorName,
			model: req.model,
		});
		return await this.run({ mode: "prompt", session, generatedAt: session.messages.length + 1, req });
	}

	async continue(
		req: Omit<AgentReq, "text" | "inputMessageId"> & { continuation?: ToolContinuation },
	): Promise<AgentRes> {
		if (req.continuation) appendToolResult(this.sessionManager(req), req.continuation);
		const session = await this.create(req.channel, req.actor, req, {
			trace: req.trace,
			agent: this.input.agent.id,
			provider: req.provider,
			channelName: req.channelName,
			thread: req.threadId,
			providerThread: req.thread,
			threadName: req.threadName,
			turn: req.turnId,
			actorName: req.actorName,
			model: req.model,
		});
		return await this.run({
			mode: "continue",
			session,
			generatedAt: session.messages.length,
			req: { ...req, text: "" },
		});
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
		req.onLiveSession?.({
			steer: async (text, attachments) => {
				const prompt = await attachmentInput(
					this.attachmentRuntime(),
					text,
					attachments,
					this.input.attachments,
					log,
				);
				await session.steer(prompt.text, prompt.images);
			},
			followUp: async (text, attachments) => {
				const prompt = await attachmentInput(
					this.attachmentRuntime(),
					text,
					attachments,
					this.input.attachments,
					log,
				);
				await session.followUp(prompt.text, prompt.images);
			},
		});
		try {
			if (mode === "continue") await session.agent.continue();
			else {
				const prompt = await attachmentInput(
					this.attachmentRuntime(),
					req.text,
					req.attachments,
					this.input.attachments,
					log,
				);
				await session.prompt(prompt.text, { expandPromptTemplates: false, images: prompt.images });
			}
		} finally {
			req.onLiveSession?.(undefined);
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
			return { text: userError(this.input.appMessages?.error ?? DEFAULT_APP_MESSAGES.error) };
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
			return { text: userError(this.input.appMessages?.error ?? DEFAULT_APP_MESSAGES.error) };
		}
		const text = out.trim();
		const silent = silentReply(text);
		const approval = approvalFromMessages(messages);
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
		return { text: silent ? "" : text, silent, approval };
	}

	private async create(
		channel: string,
		actor: string,
		req: Pick<AgentReq, "sessionId" | "sessionPath" | "scope">,
		context: {
			trace?: string;
			agent: string;
			provider: string;
			thread: string;
			providerThread?: string;
			threadName?: string;
			channelName?: string;
			turn?: string;
			message?: string;
			actorName?: string;
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
		const contextBlocks = await agentContext(agent, {
			channel,
			channelName: context.channelName,
			actor,
			actorName: context.actorName,
			provider: context.provider,
			thread: context.providerThread,
			threadName: context.threadName,
			threadId: context.thread,
			turnId: context.turn,
			inputMessageId: context.message,
			trace: context.trace,
		});
		const memoryBlock =
			this.input.memory && req.scope
				? memoryContext(req.scope.memory, await this.input.memory.read(req.scope.memory))
				: undefined;
		if (memoryBlock) contextBlocks.push(memoryBlock);
		const agentTools = splitTools(agent.tools);
		const runtime = this.runtimeFor(req.scope?.workspace.path);
		const customTools = tools({
			runtime,
			callRunner: this.input.callRunner,
			messages: this.input.messages,
			channel,
			actor,
			context: { ...context, runtimeScope: req.scope?.workspace.path },
			core: agentTools.core,
			custom: [
				...agentTools.custom,
				...memoryTools(this.input.memory, req.scope?.memory, {
					actor,
					approvers: this.input.approvalApprovers ?? [],
				}),
			],
			logger: log,
		});
		const activeToolNames: string[] = [];
		const loader = await resourceLoader(agent, settings, contextBlocks, () => activeToolNames);
		const activeTools = [...extensionToolNames(loader), ...customTools.map((tool) => tool.name)];
		activeToolNames.push(...activeTools);

		const { session, modelFallbackMessage } = await createAgentSession({
			cwd: agent.directory,
			resourceLoader: loader,
			settingsManager: settings,
			authStorage: auth,
			modelRegistry: models,
			model,
			tools: activeTools,
			sessionManager: this.sessionManager(req),
			customTools,
		});
		if (modelFallbackMessage) throw new Error(modelFallbackMessage);
		configureModelPayload(session, modelConfig);
		session.setActiveToolsByName(activeTools);
		return session;
	}

	private sessionManager(input: Pick<AgentReq, "sessionPath">): SessionManager {
		const path = sessionPath((this.input.sessionRuntime ?? this.runtimeFor()).root, input.sessionPath);
		return SessionManager.open(path, dirname(path), this.input.agent.directory);
	}

	private runtimeFor(scope?: string): Runtime {
		return typeof this.input.runtime === "function" ? this.input.runtime(scope) : this.input.runtime;
	}

	private attachmentRuntime(): Runtime {
		return this.input.attachmentRuntime ?? this.runtimeFor();
	}
}

function sessionPath(root: string, path: string): string {
	return isAbsolute(path) ? path : resolve(root, path);
}

function memoryTools(
	memory: MemoryStore | undefined,
	scope: ScopedKey | undefined,
	policy: { actor: string; approvers: string[] },
): ToolDefinition[] {
	if (!memory?.enabled() || !scope) return [];
	const assertCanWrite = () => {
		if (memory.writePolicy() === "off") throw new Error("memory writes are disabled");
		if (memory.writePolicy() === "approvers" && !policy.approvers.includes(policy.actor)) {
			throw new Error("memory writes require an approver");
		}
	};
	return [
		{
			name: "memory_read",
			label: "Memory Read",
			description: "Read persistent memory for this chat workspace.",
			parameters: Type.Object({}),
			execute: async () => toolText((await memory.read(scope)).trim() || "no memory", "memory_read"),
		},
		{
			name: "memory_write",
			label: "Memory Write",
			description: "Append one concise persistent memory item for this chat workspace.",
			parameters: Type.Object({ content: Type.String({ minLength: 1 }) }),
			execute: async (id, params) => {
				void id;
				assertCanWrite();
				const item = await memory.append(scope, stringParam(params, "content"));
				return toolText(`saved memory: ${item}`, "memory_write");
			},
		},
		{
			name: "memory_replace",
			label: "Memory Replace",
			description: "Replace exact text in persistent memory for this chat workspace.",
			parameters: Type.Object({ oldText: Type.String({ minLength: 1 }), newText: Type.String({ minLength: 1 }) }),
			execute: async (id, params) => {
				void id;
				assertCanWrite();
				await memory.replace(scope, stringParam(params, "oldText"), stringParam(params, "newText"));
				return toolText("memory updated", "memory_replace");
			},
		},
		{
			name: "memory_delete",
			label: "Memory Delete",
			description: "Delete exact text from persistent memory for this chat workspace.",
			parameters: Type.Object({ text: Type.String({ minLength: 1 }) }),
			execute: async (id, params) => {
				void id;
				assertCanWrite();
				await memory.delete(scope, stringParam(params, "text"));
				return toolText("memory deleted", "memory_delete");
			},
		},
	];
}

function toolText(text: string, tool: string) {
	return { content: [{ type: "text" as const, text }], details: { tool } };
}

function appendToolResult(session: SessionManager, input: ToolContinuation): void {
	const branch = toolResultParentEntryId(session, input.toolCallId);
	if (!branch) throw new Error(`synthetic tool result not found in Pi session: ${input.toolCallId}`);
	session.branch(branch);
	session.appendMessage(toolResult(input) as Parameters<SessionManager["appendMessage"]>[0]);
}

export function toolResultParentEntryId(session: SessionManager, toolCallId: string): string | undefined {
	for (const entry of [...session.getEntries()].reverse()) {
		if (entry.type !== "message") continue;
		const message = entry.message;
		if (message.role !== "toolResult" || message.toolCallId !== toolCallId) continue;
		return entry.parentId ?? undefined;
	}
	return undefined;
}

function toolResult(input: ToolContinuation): StoredMessage {
	return {
		role: "toolResult",
		toolCallId: input.toolCallId,
		toolName: input.tool,
		content: [{ type: "text", text: input.isError ? input.err : input.out }],
		details: { state: input.isError ? "failed" : "done" },
		isError: input.isError,
		timestamp: Date.now(),
	} as StoredMessage;
}

function configureModelPayload(session: AgentSession, model: ModelConfig): void {
	if (!model.verbosity) return;
	const previous = session.agent.onPayload;
	session.agent.onPayload = async (payload, piModel) => {
		const next = previous ? await previous(payload, piModel) : undefined;
		return applyModelPayloadConfig(next ?? payload, model);
	};
}

export function applyModelPayloadConfig(payload: unknown, model: ModelConfig): unknown {
	if (!model.verbosity) return payload;
	if (!plainObject(payload)) return payload;
	const text = plainObject(payload.text) ? payload.text : {};
	return { ...payload, text: { ...text, verbosity: model.verbosity } };
}

function plainObject(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

async function resourceLoader(
	agent: AgentConfig,
	settings: SettingsManager,
	contextBlocks: string[] = [],
	activeTools: () => string[] = () => [],
): Promise<ResourceLoader> {
	const loader = new DefaultResourceLoader({
		cwd: agent.directory,
		agentDir: agent.directory,
		settingsManager: settings,
		noExtensions: true,
		noSkills: true,
		noPromptTemplates: true,
		additionalExtensionPaths: agent.extensions ?? [],
		additionalSkillPaths: agent.skills ?? [],
		systemPromptOverride: () => agent.systemPrompt ?? runtimeSystemPrompt(activeTools()),
		appendSystemPromptOverride: () =>
			[agent.soul, agent.prompt, ...contextBlocks].filter((text): text is string => Boolean(text)),
		agentsFilesOverride: () => ({ agentsFiles: [] }),
	});
	await loader.reload();
	return loader;
}

export function runtimeSystemPrompt(activeTools: string[]): string {
	const tools = new Set(activeTools);
	const guidance = [DEFAULT_SYSTEM];
	const fileTools = ["read", "grep", "find", "ls"].filter((tool) => tools.has(tool));
	if (tools.has("bash") && fileTools.length > 0) {
		guidance.push(
			"If dedicated file/search tools are available, prefer them over shell commands for file exploration.",
		);
		guidance.push(
			"Use shell tools for commands, package managers, process inspection, and tasks not covered by narrower tools.",
		);
	} else if (tools.has("bash")) {
		guidance.push("Use shell tools for shell commands and file exploration tasks.");
	} else if (fileTools.length > 0) {
		guidance.push("Use dedicated file/search tools for file exploration.");
	}
	return guidance.join("\n\n");
}

async function agentContext(agent: AgentConfig, input: AgentContextInput): Promise<string[]> {
	const out: string[] = [];
	const channel = channelContext(input);
	if (channel) out.push(channel);
	for (const provider of agent.context ?? []) {
		const block = await provider(input);
		const rendered = renderContextBlock(block);
		if (rendered) out.push(rendered);
	}
	return out;
}

function channelContext(input: AgentContextInput): string | undefined {
	const lines = [
		"This message arrived through an external chat or webhook adapter. Replies are sent back to the same provider, channel, and thread unless the user or runtime routes them elsewhere.",
		`Provider: ${input.provider}`,
		input.channelName ? `Channel: ${input.channelName} (${input.channel})` : `Channel id: ${input.channel}`,
		input.threadName
			? `Thread: ${input.threadName}${input.thread ? ` (${input.thread})` : ""}`
			: input.thread
				? `Thread id: ${input.thread}`
				: undefined,
		input.actorName ? `Sender: ${input.actorName} (${input.actor})` : `Sender id: ${input.actor}`,
	];
	return renderContextBlock({
		title: "Current Channel",
		text: lines.filter((line): line is string => Boolean(line)).join("\n"),
	});
}

export function renderContextBlock(block: AgentContextBlock | undefined | null | false): string | undefined {
	if (!block) return undefined;
	if (typeof block === "string") return block.trim() || undefined;
	const text = block.text.trim();
	if (!text) return undefined;
	const title = block.title?.trim();
	return title ? `## ${title}\n\n${text}` : text;
}

export function approvalFromMessages(messages: StoredMessage[]): ApprovalPrompt | undefined {
	for (const message of [...messages].reverse()) {
		if (!("details" in message)) continue;
		const approval = approvalFromDetails(message.details);
		if (approval) return approval;
	}
	return undefined;
}

function approvalFromDetails(details: unknown): ApprovalPrompt | undefined {
	if (!details || typeof details !== "object" || !("approval" in details)) return undefined;
	const approval = (details as { approval?: unknown }).approval;
	if (!approval || typeof approval !== "object") return undefined;
	const input = approval as Record<string, unknown>;
	if (
		typeof input.id !== "string" ||
		typeof input.callId !== "string" ||
		typeof input.command !== "string" ||
		typeof input.runtime !== "string" ||
		typeof input.reason !== "string" ||
		!Array.isArray(input.allowed)
	) {
		return undefined;
	}
	return {
		id: input.id,
		callId: input.callId,
		command: input.command,
		runtime: input.runtime,
		reason: input.reason,
		allowed: input.allowed.filter((item): item is string => typeof item === "string"),
		...(typeof input.requestedBy === "string" ? { requestedBy: input.requestedBy } : {}),
		...(Array.isArray(input.details) ? { details: normalizeApprovalDetails(input.details) ?? [] } : {}),
	};
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
