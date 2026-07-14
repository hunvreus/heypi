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
	sharedDir?: string;
	sessionDir: string;
	extensionPaths?: string[];
	extensions?: ExtensionFactory[];
	excludeTools?: string[];
	customTools?: ToolDefinition[];
};

export type PiHost = {
	start(): Promise<void>;
	send(text: string): Promise<void>;
	steer?(text: string): Promise<void>;
	abort?(): Promise<void>;
	subscribe(listener: AgentSessionEventListener): () => void;
	stop(): Promise<void>;
};

export type PiEvent = AgentSessionEvent;

export function createPiHost(options: PiHostOptions): PiHost {
	let runtime: AgentSessionRuntime | undefined;
	let cleanupRuntimeTools: (() => Promise<void>) | undefined;

	return {
		async start() {
			const manager = SessionManager.create(options.workspaceDir, options.sessionDir);
			const runtimeTools =
				options.agent.noTools === "all"
					? { tools: [], async cleanup() {} }
					: await createRuntimeTools(options.agent.runtime, options.workspaceDir, options.sharedDir);
			cleanupRuntimeTools = runtimeTools.cleanup;
			const prompt = [
				"Incoming chat messages are supplied as the current chat delta. Reply in the same remote thread.",
				options.sharedDir
					? "Use /workspace for this channel or DM. Use /shared only for reusable adapter-level files. Do not put secrets or private channel-specific content in /shared."
					: undefined,
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

		async steer(text) {
			if (!runtime) throw new Error("Pi session is not started");
			await runtime.session.steer(text);
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
