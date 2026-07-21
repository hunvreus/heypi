import { isAbsolute, posix, relative, resolve, sep } from "node:path";
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
import { GUEST_SHARED, GUEST_SKILLS, GUEST_WORKSPACE } from "./runtime-path.js";
import { createRuntimeTools } from "./runtime-tools.js";
import type { AgentConfig } from "./types.js";

export type PiHostOptions = {
	agent: AgentConfig;
	agentDir: string;
	workspaceDir: string;
	sharedDir?: string;
	sessionDir: string;
	extensionPaths?: string[];
	skillsDir?: string;
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

function runtimeSkillPath(root: string, path: string): string {
	const rel = relative(resolve(root), resolve(path));
	if (rel === "") return GUEST_SKILLS;
	if (rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel)) {
		throw new Error("Skill path escapes the configured skills root.");
	}
	return posix.join(GUEST_SKILLS, rel.split(sep).join("/"));
}

/** Replace HeyPi's physical storage roots before Pi sends its generated prompt to the model. */
export function createRuntimePromptExtension(options: PiHostOptions): ExtensionFactory {
	const paths = [
		[resolve(options.workspaceDir), GUEST_WORKSPACE],
		...(options.sharedDir ? [[resolve(options.sharedDir), GUEST_SHARED]] : []),
		...(options.skillsDir ? [[resolve(options.skillsDir), GUEST_SKILLS]] : []),
		[resolve(options.agentDir), "/agent"],
		[resolve(options.sessionDir), "/sessions"],
	] as Array<[string, string]>;
	paths.sort(([left], [right]) => right.length - left.length);
	return (pi) => {
		pi.on("before_agent_start", (event) => {
			let systemPrompt = event.systemPrompt;
			if (event.systemPromptOptions.customPrompt) {
				const active = new Set(pi.getActiveTools());
				const guidelines = new Set(
					pi
						.getAllTools()
						.filter((tool) => active.has(tool.name))
						.flatMap((tool) => tool.promptGuidelines ?? [])
						.map((line) => line.trim())
						.filter(Boolean),
				);
				if (guidelines.size)
					systemPrompt += `\n\n## Tool guidance\n\n${[...guidelines].map((line) => `- ${line}`).join("\n")}`;
			}
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
					: await createRuntimeTools(
							options.agent.runtime,
							options.workspaceDir,
							options.sharedDir,
							options.skillsDir,
						);
			prepareRuntimeTools = runtimeTools.prepare;
			cleanupRuntimeTools = runtimeTools.cleanup;
			const prompt = [
				options.mode === "background"
					? "This is a scheduled background run with no chat history or remote reply target. Complete the prompt and return a concise final result."
					: "You are responding through HeyPi. Each turn includes HeyPi-asserted context followed by user-authored messages. actor.id is the authoritative identity value; names are display labels. HeyPi, not you, enforces access and tool permissions. HeyPi routes your final response to the active conversation.",
				options.mode !== "background"
					? options.sharedDir
						? "Use /workspace for conversation files. Use /shared only for reusable adapter-level files; never store secrets or conversation-private content there."
						: "Use /workspace for conversation files."
					: undefined,
				options.skillsDir
					? "Agent skills are managed under /agent/skills. Do not modify them. When a listed skill clearly applies, read it before acting."
					: undefined,
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
						noSkills: true,
						additionalExtensionPaths: options.extensionPaths,
						additionalSkillPaths: options.skillsDir ? [options.skillsDir] : undefined,
						extensionFactories: extensions,
						appendSystemPromptOverride: (base) => (prompt ? [...base, prompt] : base),
						skillsOverride: ({ skills, diagnostics }) => ({
							diagnostics,
							skills: skills.map((skill) => ({
								...skill,
								filePath: options.skillsDir
									? runtimeSkillPath(options.skillsDir, skill.filePath)
									: skill.filePath,
								baseDir: options.skillsDir ? runtimeSkillPath(options.skillsDir, skill.baseDir) : skill.baseDir,
							})),
						}),
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
