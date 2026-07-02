import { join } from "node:path";
import {
	type AgentSession,
	type AgentSessionRuntime,
	type CreateAgentSessionRuntimeFactory,
	createAgentSessionFromServices,
	createAgentSessionRuntime,
	createAgentSessionServices,
	type ExtensionFactory,
	SessionManager,
	type ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import type { AgentConfig } from "./types.js";

export type PiHostOptions = {
	agent: AgentConfig;
	agentDir: string;
	workspaceDir: string;
	sessionDir: string;
	extensionPaths?: string[];
	extensions?: ExtensionFactory[];
	tools?: ToolDefinition[];
};

export type PiHost = {
	start(): Promise<void>;
	send(text: string): Promise<void>;
	subscribe(listener: AgentSession["subscribe"] extends (listener: infer T) => unknown ? T : never): () => void;
	stop(): Promise<void>;
};

export function sessionDir(stateDir: string, key: string): string {
	return join(stateDir, "sessions", key);
}

export function createPiHost(options: PiHostOptions): PiHost {
	let runtime: AgentSessionRuntime | undefined;

	return {
		async start() {
			const manager = SessionManager.create(options.workspaceDir, options.sessionDir);
			const prompt = [
				options.agent.instructions,
				options.agent.system,
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
				const result = await createAgentSessionFromServices({
					services,
					sessionManager,
					sessionStartEvent,
					model: options.agent.model,
					tools: options.agent.tools,
					excludeTools: options.agent.excludeTools,
					noTools: options.agent.noTools,
					customTools: options.tools,
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

		subscribe(listener) {
			if (!runtime) throw new Error("Pi session is not started");
			return runtime.session.subscribe(listener);
		},

		async stop() {
			await runtime?.dispose();
			runtime = undefined;
		},
	};
}
