import { resolve } from "node:path";
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
import { GUEST_SHARED, GUEST_WORKSPACE } from "./runtime-path.js";
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
	mode?: "chat" | "background";
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

/** Replace HeyPi's physical storage roots before Pi sends its generated prompt to the model. */
export function createRuntimePromptExtension(options: PiHostOptions): ExtensionFactory {
	const paths = [
		[resolve(options.workspaceDir), GUEST_WORKSPACE],
		...(options.sharedDir ? [[resolve(options.sharedDir), GUEST_SHARED]] : []),
		[resolve(options.agentDir), "/agent"],
		[resolve(options.sessionDir), "/sessions"],
	] as Array<[string, string]>;
	paths.sort(([left], [right]) => right.length - left.length);
	return (pi) => {
		pi.on("before_agent_start", (event) => {
			let systemPrompt = event.systemPrompt;
			for (const [host, guest] of paths) systemPrompt = systemPrompt.replaceAll(host, guest);
			return systemPrompt === event.systemPrompt ? undefined : { systemPrompt };
		});
	};
}

export function createPiHost(options: PiHostOptions): PiHost {
	let runtime: AgentSessionRuntime | undefined;
	let prepareRuntimeTools: (() => Promise<void>) | undefined;
	let cleanupRuntimeTools: (() => Promise<void>) | undefined;

	return {
		async start() {
			const manager = SessionManager.create(options.workspaceDir, options.sessionDir);
			const runtimeTools =
				options.agent.noTools === "all"
					? { tools: [], async cleanup() {} }
					: await createRuntimeTools(options.agent.runtime, options.workspaceDir, options.sharedDir);
			prepareRuntimeTools = runtimeTools.prepare;
			cleanupRuntimeTools = runtimeTools.cleanup;
			const prompt = [
				options.mode === "background"
					? "This is a scheduled background run with no chat history or remote reply target. Complete the prompt and return a concise final result."
					: "Incoming chat messages are supplied as the current chat delta. Reply in the same remote thread.",
				options.sharedDir
					? "Use /workspace for this channel or DM. Use /shared only for reusable adapter-level files. Do not put secrets or private channel-specific content in /shared."
					: undefined,
				"Use staged agent skills, tools, and extensions when they apply.",
			]
				.filter(Boolean)
				.join("\n\n");
			const extensions = [createRuntimePromptExtension(options), ...(options.extensions ?? [])];
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
						noContextFiles: true,
						additionalExtensionPaths: options.extensionPaths,
						extensionFactories: extensions,
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
			try {
				runtime = await createAgentSessionRuntime(createRuntime, {
					cwd: options.workspaceDir,
					agentDir: options.agentDir,
					sessionManager: manager,
				});
				runtime.session.sessionManager.appendSessionInfo(`heypi ${options.agent.id}`);
			} catch (error) {
				const failures: unknown[] = [error];
				try {
					await runtime?.dispose();
				} catch (disposeError) {
					failures.push(disposeError);
				}
				try {
					await cleanupRuntimeTools?.();
				} catch (cleanupError) {
					failures.push(cleanupError);
				} finally {
					runtime = undefined;
					prepareRuntimeTools = undefined;
					cleanupRuntimeTools = undefined;
				}
				if (failures.length > 1)
					throw new AggregateError(failures, "Pi startup and runtime cleanup failed", { cause: error });
				throw error;
			}
		},

		async send(text) {
			if (!runtime) throw new Error("Pi session is not started");
			await prepareRuntimeTools?.();
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
				prepareRuntimeTools = undefined;
				cleanupRuntimeTools = undefined;
			}
		},
	};
}
