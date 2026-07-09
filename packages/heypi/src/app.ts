import { join } from "node:path";
import type { ExtensionFactory, ToolDefinition } from "@earendil-works/pi-coding-agent";
import { createAdmin } from "./admin.js";
import { stageAgent } from "./agent.js";
import { createApprovalExtension } from "./approval.js";
import { type Channel, createChannel } from "./channel.js";
import { createChatHistoryTool } from "./chat-tools.js";
import { type AdapterEvent, type ChatJob, defaultAdapterEvents } from "./events.js";
import { consoleLogger } from "./log.js";
import { createFileMemoryStore, createMemoryExtension } from "./memory.js";
import { createPiHost, type PiEvent, type PiHost, type PiHostOptions, sessionDir } from "./pi.js";
import { createStatusSlot, type StatusSlot } from "./status.js";
import { createTodoController, renderTodo, type TodoController } from "./todo.js";
import type { Adapter, AgentConfig, ApprovalPolicy, ChatMessage, Logger, ToolEntry } from "./types.js";

export type HeypiApp = {
	start(): Promise<void>;
	stop(): Promise<void>;
	jobs(): ChatJob[];
	cancelQueued(reason?: string): Promise<number>;
	cancelActive(reason?: string): Promise<number>;
};

export type CreateHeypiOptions = {
	agent: AgentConfig | Promise<AgentConfig>;
	adapters: Adapter[];
	logger?: Logger;
	piHost?: PiHostFactory;
};

export type PiHostFactory = (options: PiHostOptions) => PiHost;

type RunningChannel = {
	channel: Channel;
	adapter: Adapter;
	pi?: PiHost;
	status?: StatusSlot;
	activeMessage?: ChatMessage;
	todo?: TodoController;
	todoActive?: boolean;
	todoTasks: Promise<void>[];
	canceling?: string;
};

function keyFor(message: ChatMessage): string {
	return `${message.adapter}:${message.account}:${message.conversation}:${message.thread ?? ""}`.replace(
		/[^a-zA-Z0-9_.:-]/g,
		"_",
	);
}

function assistantText(message: { role?: string; content?: unknown }): string {
	const content = message.content;
	if (Array.isArray(content)) {
		return content
			.map((part) => (part && typeof part === "object" && "text" in part ? String(part.text) : ""))
			.join("");
	}
	return typeof content === "string" ? content : "";
}

function includes(values: string[] | undefined, value: string): boolean {
	return !values || values.includes(value);
}

function botAllowed(allow: Adapter["allow"], message: ChatMessage): boolean {
	if (!message.user.isBot) return true;
	if (message.user.isSelf) return false;
	if (allow?.bots === true) return true;
	return Array.isArray(allow?.bots) && allow.bots.includes(message.user.id);
}

function allowed(adapter: Adapter, message: ChatMessage): boolean {
	const allow = adapter.allow;
	if (!botAllowed(allow, message)) return false;
	if (!allow) return true;
	return (
		includes(allow.adapters, message.adapter) &&
		includes(allow.accounts, message.account) &&
		includes(allow.conversations, message.conversation) &&
		(message.user.isBot || includes(allow.users, message.user.id))
	);
}

type ToolSettings = {
	tools?: string[];
	excludeTools?: string[];
	customTools: ToolDefinition[];
	approvalPolicies: Record<string, ApprovalPolicy | false | undefined>;
};

function isToolImplementation(entry: ToolEntry): entry is ToolDefinition {
	return (
		typeof entry === "object" && entry !== null && "name" in entry && "description" in entry && "parameters" in entry
	);
}

function toolSettings(agent: AgentConfig): ToolSettings {
	const include = new Set<string>();
	const exclude = new Set<string>();
	const customTools: ToolDefinition[] = [];
	const approvalPolicies: ToolSettings["approvalPolicies"] = {};
	for (const [name, entry] of Object.entries(agent.tools ?? {})) {
		if (entry === undefined) continue;
		if (entry === false) {
			exclude.add(name);
			continue;
		}
		if (isToolImplementation(entry)) {
			customTools.push(entry);
			include.add(name);
			continue;
		}
		const config = entry as Exclude<ToolEntry, false | ToolDefinition>;
		if (config.approve) approvalPolicies[name] = config.approve;
		include.add(name);
	}
	return {
		tools: include.size ? [...include].sort() : undefined,
		excludeTools: exclude.size ? [...exclude].sort() : undefined,
		customTools,
		approvalPolicies,
	};
}

function piToolName(event: PiEvent): string | undefined {
	if (event.type !== "tool_execution_start") return undefined;
	if (!("toolName" in event)) return undefined;
	return typeof event.toolName === "string" ? event.toolName : undefined;
}

function todoEnabled(agent: AgentConfig): boolean {
	return agent.todo !== false;
}

function eventHandlers(adapter: Adapter) {
	const defaults = adapter.progress === false ? {} : defaultAdapterEvents();
	return { ...defaults, ...(adapter.events ?? {}) };
}

export async function createHeypi(options: CreateHeypiOptions): Promise<HeypiApp> {
	const agent = await options.agent;
	const logger = options.logger ?? consoleLogger;
	const piHost = options.piHost ?? createPiHost;
	const stateDir = agent.state?.dir ?? join(process.cwd(), ".heypi");
	const toolConfig = toolSettings(agent);
	const staged = await stageAgent(agent, stateDir);
	const channels = new Map<string, RunningChannel>();
	const loadingChannels = new Map<string, Promise<RunningChannel>>();
	const admin = agent.admin
		? createAdmin({ ...agent.admin, stateDir, jobs: () => appJobs(), cancel: cancelJobs })
		: undefined;
	let stopping = false;

	function appJobs(): ChatJob[] {
		return [...channels.values()].flatMap((running) => running.channel.jobs());
	}

	async function cancelJobs(
		scope: "active" | "queued" | "all",
		reason?: string,
	): Promise<{ active: number; queued: number }> {
		const active =
			scope === "active" || scope === "all"
				? await Promise.all([...channels.values()].map((running) => cancelActive(running, reason))).then((counts) =>
						counts.reduce((sum, count) => sum + count, 0),
					)
				: 0;
		const queued =
			scope === "queued" || scope === "all"
				? await Promise.all([...channels.values()].map((running) => running.channel.cancelQueued(reason))).then(
						(counts) => counts.reduce((sum, count) => sum + count, 0),
					)
				: 0;
		return { active, queued };
	}

	async function channelFor(adapter: Adapter, message: ChatMessage): Promise<RunningChannel> {
		const key = keyFor(message);
		const cached = channels.get(key);
		if (cached) return cached;
		const loading = loadingChannels.get(key);
		if (loading) return loading;
		const channel = createChannel({
			logPath: join(stateDir, "channels", `${key}.jsonl`),
		});
		const loadingChannel = (async () => {
			await channel.load();
			const running = { adapter, channel, todoTasks: [] };
			channels.set(key, running);
			return running;
		})();
		loadingChannels.set(key, loadingChannel);
		try {
			return await loadingChannel;
		} finally {
			loadingChannels.delete(key);
		}
	}

	async function startPi(running: RunningChannel, message: ChatMessage): Promise<PiHost> {
		if (running.pi) return running.pi;
		const adapter = running.adapter;
		const channel = running.channel;
		const key = keyFor(message);
		const approvalExtension =
			adapter.approvals === undefined || Object.keys(toolConfig.approvalPolicies).length === 0
				? undefined
				: createApprovalExtension({
						config: adapter.approvals,
						admins: adapter.admins,
						approvers: adapter.approvers,
						policies: toolConfig.approvalPolicies,
						context: () => ({
							adapter: message.adapter,
							account: message.account,
							conversation: message.conversation,
							thread: channel.activeMessageId(),
							actor: channel.activeUser(),
						}),
						request: (view) =>
							adapter.requestApproval?.({
								...view,
								conversation: message.conversation,
								thread: channel.activeMessageId(),
							}) ??
							Promise.resolve({ approved: false, reason: `${adapter.kind} adapter cannot approve tools.` }),
					});
		const todo = todoEnabled(agent)
			? createTodoController({
					render: async (update) => {
						running.todoActive = true;
						const job = currentJob(running);
						const status = running.status;
						if (!status || !job) return;
						await emit(running, {
							type: "todo.changed",
							origin: "heypi",
							job,
							text: renderTodo(update),
						});
					},
				})
			: undefined;
		running.todo = todo;
		const memoryExtension = createMemoryExtension({
			store: createFileMemoryStore(join(stateDir, "memory", `${key}.jsonl`)),
		});
		const extensions: ExtensionFactory[] = [];
		if (approvalExtension) extensions.push(approvalExtension);
		if (todo) extensions.push(todo.extension);
		if (memoryExtension) extensions.push(memoryExtension);
		const pi = piHost({
			agent,
			agentDir: staged.agentDir,
			workspaceDir: staged.workspaceDir,
			sessionDir: sessionDir(stateDir, key),
			extensionPaths: staged.extensionPaths,
			tools: toolConfig.tools,
			excludeTools: toolConfig.excludeTools,
			customTools: [createChatHistoryTool(channel), ...toolConfig.customTools],
			extensions,
		});
		await pi.start();
		running.pi = pi;
		return pi;
	}

	function currentJob(running: RunningChannel): ChatJob | undefined {
		return running.channel.jobs().find((job) => job.state === "running");
	}

	async function cancelActive(running: RunningChannel, reason = "canceled"): Promise<number> {
		const job = currentJob(running);
		if (!job || !running.pi?.abort) return 0;
		running.canceling = reason;
		await running.pi.abort();
		return 1;
	}

	async function emit(running: RunningChannel, event: AdapterEvent): Promise<void> {
		const handler = eventHandlers(running.adapter)[event.type];
		if (handler === false || !handler) return;
		const message = event.type === "message.accepted" ? event.message : running.activeMessage;
		if (!message) return;
		await handler(event as never, {
			message,
			job: "job" in event ? event.job : undefined,
			status: running.status,
			send: (message) => running.adapter.send(message),
		});
	}

	async function emitAccepted(adapter: Adapter, message: ChatMessage): Promise<void> {
		const handler = eventHandlers(adapter)["message.accepted"];
		if (handler === false || !handler) return;
		await handler({ type: "message.accepted", origin: "heypi", message } as never, {
			message,
			send: (message) => adapter.send(message),
		});
	}

	async function dispatch(running: RunningChannel, message: ChatMessage): Promise<void> {
		const turn = running.channel.next();
		if (!turn) return;
		if (stopping) {
			await running.channel.fail("stopped");
			return;
		}
		logger.info("turn.start", {
			adapter: message.adapter,
			conversation: message.conversation,
			thread: turn.replyThread,
		});
		let finalText = "";
		let unsubscribe: (() => void) | undefined;
		try {
			running.activeMessage = message;
			running.status = createStatusSlot({ adapter: running.adapter, message, thread: turn.replyThread });
			running.todoActive = false;
			running.todoTasks = [];
			const pi = await startPi(running, message);
			running.todo?.reset();
			const job = currentJob(running);
			if (job) await emit(running, { type: "turn.started", origin: "pi", job });
			unsubscribe = pi.subscribe((event) => {
				if (event.type === "message_end" && event.message.role === "assistant") {
					finalText = assistantText(event.message);
				}
				const toolName = piToolName(event);
				if (toolName) {
					logger.info("pi.tool.start", {
						adapter: message.adapter,
						conversation: message.conversation,
						thread: turn.replyThread,
						tool: toolName,
					});
					const job = currentJob(running);
					if (job) void emit(running, { type: "tool.started", origin: "pi", job, tool: toolName });
				}
			});
			await pi.send(turn.prompt);
			await running.status.wait();
			if (stopping) {
				await running.todo?.cancel();
				await Promise.allSettled(running.todoTasks);
				await running.channel.fail("stopped");
				return;
			}
			await running.todo?.complete();
			await Promise.allSettled(running.todoTasks);
			const final = finalText.trim();
			const completedJob = currentJob(running);
			if (completedJob)
				await emit(running, { type: "message.completed", origin: "pi", job: completedJob, text: finalText });
			if (final) {
				const replaced = await running.status.final(finalText);
				if (!replaced) {
					await running.adapter.send({
						conversation: message.conversation,
						thread: turn.replyThread,
						text: finalText,
					});
				}
			} else if (!running.todoActive) {
				await running.status.final("Done.");
			}
			await running.channel.complete(finalText);
			logger.info("turn.complete", {
				adapter: message.adapter,
				conversation: message.conversation,
				thread: turn.replyThread,
			});
		} catch (error) {
			const text = error instanceof Error ? error.message : String(error);
			await running.status?.wait();
			if (stopping || running.canceling) await running.todo?.cancel();
			else await running.todo?.fail();
			await Promise.allSettled(running.todoTasks);
			const canceled = running.canceling;
			const job = currentJob(running);
			if (canceled) {
				if (job) await emit(running, { type: "turn.canceled", origin: "heypi", job, reason: canceled });
				await running.channel.cancelActive(canceled);
				logger.info("turn.cancel", {
					adapter: message.adapter,
					conversation: message.conversation,
					thread: turn.replyThread,
					reason: canceled,
				});
				const text = canceled === "canceled" ? "Canceled." : `Canceled: ${canceled}`;
				const replaced = await (running.status?.error(text) ?? Promise.resolve(false));
				if (!replaced) {
					await running.adapter.send({
						conversation: message.conversation,
						thread: turn.replyThread,
						text,
					});
				}
			} else {
				if (job) await emit(running, { type: "turn.failed", origin: "heypi", job, error: text });
				await running.channel.fail(text);
				logger.error("turn.fail", {
					adapter: message.adapter,
					conversation: message.conversation,
					thread: turn.replyThread,
					message: text,
				});
			}
			running.canceling = undefined;
			if (stopping) return;
			if (!canceled) {
				const failure = `The agent failed: ${text}`;
				const replaced = await (running.status?.error(failure) ?? Promise.resolve(false));
				if (!replaced) {
					await running.adapter.send({
						conversation: message.conversation,
						thread: turn.replyThread,
						text: failure,
					});
				}
			}
		} finally {
			unsubscribe?.();
		}
		if (stopping) return;
		await dispatch(running, message);
	}

	async function receive(adapter: Adapter, message: ChatMessage): Promise<void> {
		if (stopping) return;
		if (message.user.isSelf) {
			logger.debug("adapter.message_ignored", {
				adapter: message.adapter,
				conversation: message.conversation,
				user: message.user.id,
				reason: "self",
			});
			return;
		}
		if (!allowed(adapter, message)) {
			logger.warn("adapter.message_denied", {
				adapter: message.adapter,
				account: message.account,
				conversation: message.conversation,
				user: message.user.id,
			});
			return;
		}
		await emitAccepted(adapter, message);
		try {
			await adapter.ack?.(message);
		} catch (error) {
			logger.warn("adapter.ack_failed", {
				adapter: adapter.kind,
				message: error instanceof Error ? error.message : String(error),
			});
		}
		const running = await channelFor(adapter, message);
		const queued = await running.channel.ingest(message);
		logger.info("adapter.message", {
			adapter: message.adapter,
			conversation: message.conversation,
			thread: message.thread,
			user: message.user.id,
			queued,
		});
		if (queued) {
			await dispatch(running, message);
		}
	}

	return {
		async start() {
			stopping = false;
			await admin?.start();
			if (admin) logger.info("admin.start", { url: admin.url() });
			const adapters = options.adapters;
			for (const adapter of adapters) {
				await adapter.start({ agentId: agent.id, logger, receive: (message) => receive(adapter, message) });
			}
			const adapterNames = adapters.map((adapter) => adapter.name ?? adapter.kind);
			logger.info("app.start", { agent: agent.id, adapters: adapterNames.length, admin: admin?.url() });
			logger.ready?.({ agent: agent.id, adapters: adapterNames, admin: admin?.url() });
		},
		async stop() {
			stopping = true;
			for (const channel of channels.values()) await channel.pi?.stop();
			for (const adapter of options.adapters) await adapter.stop?.();
			await admin?.stop();
			logger.info("app.stop", { agent: agent.id });
		},
		jobs() {
			return appJobs();
		},
		async cancelQueued(reason) {
			return (await cancelJobs("queued", reason)).queued;
		},
		async cancelActive(reason = "canceled") {
			return (await cancelJobs("active", reason)).active;
		},
	};
}

export async function runHeypi(agent: AgentConfig | Promise<AgentConfig>, adapters: Adapter[]): Promise<HeypiApp> {
	const app = await createHeypi({ agent, adapters });
	await app.start();
	return app;
}
