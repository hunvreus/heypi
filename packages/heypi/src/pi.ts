import { join } from "node:path";
import {
	type AgentSessionEvent,
	type AgentSessionEventListener,
	type AgentSessionRuntime,
	type CreateAgentSessionRuntimeFactory,
	createAgentSession,
	createAgentSessionRuntime,
	createAgentSessionServices,
	type ExtensionFactory,
	SessionManager,
	type ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import { createRuntimeTools } from "./runtime-tools.js";
import type { AgentConfig } from "./types.js";

export type PiHostOptions = {
	agent: AgentConfig;
	agentDir: string;
	workspaceDir: string;
	sessionDir: string;
	extensionPaths?: string[];
	extensions?: ExtensionFactory[];
	tools?: string[];
	excludeTools?: string[];
	customTools?: ToolDefinition[];
};

export type PiHost = {
	start(): Promise<void>;
	send(text: string): Promise<void>;
	abort?(): Promise<void>;
	subscribe(listener: AgentSessionEventListener): () => void;
	stop(): Promise<void>;
};

export type PiEvent = AgentSessionEvent;

export function sessionDir(stateDir: string, key: string): string {
	return join(stateDir, "sessions", key);
}

export function createPiHost(options: PiHostOptions): PiHost {
	let runtime: AgentSessionRuntime | undefined;
	let cleanupRuntimeTools: (() => Promise<void>) | undefined;

	return {
		async start() {
			const manager = SessionManager.create(options.workspaceDir, options.sessionDir);
			const runtimeTools =
				options.agent.noTools === "all"
					? { tools: [], async cleanup() {} }
					: await createRuntimeTools(options.agent.runtime, options.workspaceDir);
			cleanupRuntimeTools = runtimeTools.cleanup;
			const prompt = [
				"Incoming chat messages are supplied as the current chat delta. Reply in the same remote thread.",
				"Use staged agent skills, tools, and extensions when they apply.",
			]
				.filter(Boolean)
				.join("\n\n");
			const createRuntime: CreateAgentSessionRuntimeFactory = async ({
				cwd,
				agentDir,
				sessionManager,
				sessionStartEvent,
			}) => {
				const services = await createAgentSessionServices({
					cwd,
					agentDir,
					resourceLoaderOptions: {
						additionalExtensionPaths: options.extensionPaths,
						extensionFactories: options.extensions,
						appendSystemPrompt: prompt ? [prompt] : undefined,
					},
				});
				const result = await createAgentSession({
					cwd: services.cwd,
					agentDir: services.agentDir,
					authStorage: services.authStorage,
					settingsManager: services.settingsManager,
					modelRegistry: services.modelRegistry,
					resourceLoader: services.resourceLoader,
					sessionManager,
					sessionStartEvent,
					model: options.agent.model,
					tools: options.tools,
					excludeTools: options.excludeTools,
					noTools: options.agent.noTools ?? "builtin",
					customTools: [...runtimeTools.tools, ...(options.customTools ?? [])],
				});
				return { ...result, services, diagnostics: services.diagnostics };
			};
			runtime = await createAgentSessionRuntime(createRuntime, {
				cwd: options.workspaceDir,
				agentDir: options.agentDir,
				sessionManager: manager,
			});
			runtime.session.sessionManager.appendSessionInfo(`heypi ${options.agent.id}`);
		},

		async send(text) {
			if (!runtime) throw new Error("Pi session is not started");
			await runtime.session.sendUserMessage(text);
		},

		async abort() {
			if (!runtime) return;
			await runtime.session.abort();
		},

		subscribe(listener) {
			if (!runtime) throw new Error("Pi session is not started");
			return runtime.session.subscribe(listener);
		},

		async stop() {
			try {
				await runtime?.dispose();
			} finally {
				await cleanupRuntimeTools?.();
				runtime = undefined;
				cleanupRuntimeTools = undefined;
			}
		},
	};
}
