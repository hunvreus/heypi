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
import type { AgentConfig } from "../types.js";

export type PiSessionHostOptions = {
	agent: AgentConfig;
	agentDir: string;
	workspaceDir: string;
	sessionDir: string;
	toolPaths: string[];
	customTools?: ToolDefinition[];
	extensionFactories?: ExtensionFactory[];
};

export class PiSessionHost {
	private runtime: AgentSessionRuntime | undefined;

	constructor(private readonly options: PiSessionHostOptions) {}

	async start(): Promise<void> {
		const sessionManager = SessionManager.create(this.options.workspaceDir, this.options.sessionDir);
		const appendSystemPrompt = [
			this.options.agent.instructions,
			this.options.agent.system,
			"Incoming chat messages are provided as the current chat delta. Answer in the same chat thread.",
			"Use skills and extensions from the staged agent bundle when they apply.",
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
					additionalExtensionPaths: this.options.toolPaths,
					extensionFactories: this.options.extensionFactories,
					appendSystemPrompt: appendSystemPrompt ? [appendSystemPrompt] : undefined,
				},
			});
			const result = await createAgentSessionFromServices({
				services,
				sessionManager,
				sessionStartEvent,
				model: this.options.agent.model,
				tools: this.options.agent.tools,
				excludeTools: this.options.agent.excludeTools,
				noTools: this.options.agent.noTools,
				customTools: this.options.customTools,
			});
			return { ...result, services, diagnostics: services.diagnostics };
		};
		this.runtime = await createAgentSessionRuntime(createRuntime, {
			cwd: this.options.workspaceDir,
			agentDir: this.options.agentDir,
			sessionManager,
		});
		this.runtime.session.sessionManager.appendSessionInfo(`heypi ${this.options.agent.id}`);
	}

	subscribe(listener: AgentSession["subscribe"] extends (listener: infer T) => unknown ? T : never): () => void {
		if (!this.runtime) throw new Error("Pi session is not started");
		return this.runtime.session.subscribe(listener);
	}

	async send(prompt: string): Promise<void> {
		if (!this.runtime) throw new Error("Pi session is not started");
		await this.runtime.session.sendUserMessage(prompt);
	}

	async stop(): Promise<void> {
		await this.runtime?.dispose();
		this.runtime = undefined;
	}
}

export function piSessionDir(stateDir: string, conversationKey: string): string {
	return join(stateDir, "sessions", conversationKey);
}
