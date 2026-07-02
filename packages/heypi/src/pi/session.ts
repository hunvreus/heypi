import { join } from "node:path";
import {
	createAgentSession,
	DefaultResourceLoader,
	SessionManager,
	SettingsManager,
	type AgentSession,
	type CreateAgentSessionOptions,
} from "@earendil-works/pi-coding-agent";
import type { AgentConfig } from "../types.js";

export type PiSessionHostOptions = {
	agent: AgentConfig;
	agentDir: string;
	workspaceDir: string;
	sessionDir: string;
	toolPaths: string[];
};

export class PiSessionHost {
	private session: AgentSession | undefined;

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
		const settingsManager = SettingsManager.create(this.options.workspaceDir, this.options.agentDir);
		const resourceLoader = new DefaultResourceLoader({
			cwd: this.options.workspaceDir,
			agentDir: this.options.agentDir,
			settingsManager,
			additionalExtensionPaths: this.options.toolPaths,
			appendSystemPrompt: appendSystemPrompt ? [appendSystemPrompt] : undefined,
		});
		await resourceLoader.reload();
		const result = await createAgentSession({
			cwd: this.options.workspaceDir,
			agentDir: this.options.agentDir,
			model: this.options.agent.model,
			sessionManager,
			settingsManager,
			resourceLoader,
			tools: this.options.agent.tools,
			excludeTools: this.options.agent.excludeTools,
			noTools: this.options.agent.noTools,
		} satisfies CreateAgentSessionOptions);
		this.session = result.session;
		this.session.sessionManager.appendSessionInfo(`heypi ${this.options.agent.id}`);
	}

	subscribe(listener: AgentSession["subscribe"] extends (listener: infer T) => unknown ? T : never): () => void {
		if (!this.session) throw new Error("Pi session is not started");
		return this.session.subscribe(listener);
	}

	async send(prompt: string): Promise<void> {
		if (!this.session) throw new Error("Pi session is not started");
		await this.session.sendUserMessage(prompt);
	}

	async stop(): Promise<void> {
		this.session?.dispose();
		this.session = undefined;
	}
}

export function piSessionDir(stateDir: string, conversationKey: string): string {
	return join(stateDir, "sessions", conversationKey);
}
