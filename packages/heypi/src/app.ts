import { join } from "node:path";
import type { ExtensionFactory } from "@earendil-works/pi-coding-agent";
import { createAdmin } from "./admin.js";
import { stageAgent } from "./agent.js";
import { createApprovalExtension } from "./approval.js";
import { type Channel, createChannel } from "./channel.js";
import { createChatAttachTool, createChatHistoryTool, createChatRequestSecretTool } from "./chat-tools.js";
import type { AdapterEvent, ChatJob } from "./events.js";
import { consoleLogger } from "./log.js";
import { createFileMemoryStore, createMemoryExtension } from "./memory.js";
import { createPiHost, type PiEvent, type PiHost, type PiHostOptions } from "./pi.js";
import { createSecretManager, type SecretManager } from "./secrets.js";
import { createStatusSlot, type StatusSlot } from "./status.js";
import { type ChatStorage, ensureChatStorage, executionKey, storageFor } from "./storage.js";
import { createTodoController, renderTodo, type TodoController } from "./todo.js";
import { toolSettings } from "./tool-config.js";
import type { Adapter, AgentConfig, ChatMessage, Logger, SendMessage } from "./types.js";

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
	piStarting?: Promise<PiHost>;
	storage: ChatStorage;
	activity?: StatusSlot;
	todoStatus?: StatusSlot;
	activeMessage?: ChatMessage;
	todo?: TodoController;
	canceling?: string;
	idleTimer?: ReturnType<typeof setTimeout>;
};

const IDLE_RUNTIME_TTL_MS = 10 * 60 * 1000;

function appendUrl(base: string, suffix: string): string {
	return `${base.replace(/\/$/, "")}/${suffix.replace(/^\//, "")}`;
}

function keyFor(message: ChatMessage): string {
	return executionKey(message);
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

function piToolName(event: PiEvent): string | undefined {
	if (event.type !== "tool_execution_start") return undefined;
	if (!("toolName" in event)) return undefined;
	return typeof event.toolName === "string" ? event.toolName : undefined;
}

function piToolEnd(event: PiEvent): { tool: string; error: boolean } | undefined {
	if (event.type !== "tool_execution_end") return undefined;
	if (!("toolName" in event) || typeof event.toolName !== "string") return undefined;
	return { tool: event.toolName, error: "isError" in event && event.isError === true };
}

function todoEnabled(agent: AgentConfig): boolean {
	return agent.todo !== false;
}

function eventHandlers(adapter: Adapter) {
	return adapter.events ?? {};
}

function controlCommand(message: ChatMessage): "stop" | "status" | undefined {
	const text = message.text
		.replaceAll(/<@[^>]+>/g, " ")
		.replace(/\s+/g, " ")
		.trim()
		.toLowerCase();
	if (text === "/stop") return "stop";
	if (text === "/status") return "status";
	return undefined;
}

function userInSet(users: string[] | undefined, id: string): boolean {
	return Boolean(users?.includes(id));
}

function canControl(adapter: Adapter, message: ChatMessage, jobs: ChatJob[]): boolean {
	if (userInSet(adapter.admins?.users, message.user.id)) return true;
	return jobs.some((job) => job.actor.id === message.user.id);
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
	let secrets: SecretManager;
	const admin = agent.admin
		? createAdmin({
				...agent.admin,
				stateDir,
				jobs: () => appJobs(),
				cancel: cancelJobs,
				secret: {
					pageHtml: () => secrets.pageHtml(),
					accept: (reply) => secrets.accept(reply),
				},
			})
		: undefined;
	const secretPageUrl = admin ? appendUrl(admin.url(), "/secret") : undefined;
	secrets = createSecretManager({
		keyPath: join(stateDir, "secrets.key"),
		pageUrl: secretPageUrl,
		submitUrl: secretPageUrl,
	});
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
		if (cached) {
			if (cached.idleTimer) {
				clearTimeout(cached.idleTimer);
				cached.idleTimer = undefined;
			}
			return cached;
		}
		const loading = loadingChannels.get(key);
		if (loading) return loading;
		const storage = storageFor(agent, stateDir, message);
		const loadingChannel = (async () => {
			await ensureChatStorage(storage);
			const channel = createChannel({ logPath: storage.logPath, lockPath: storage.lockPath });
			await channel.load();
			const running = { adapter, channel, storage };
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

	async function sendLogged(running: RunningChannel, message: SendMessage): Promise<{ id?: string } | undefined> {
		const sent = await running.adapter.send(message);
		await running.channel.outbound(message, sent?.id);
		return sent;
	}

	async function startPi(running: RunningChannel, message: ChatMessage): Promise<PiHost> {
		if (running.idleTimer) {
			clearTimeout(running.idleTimer);
			running.idleTimer = undefined;
		}
		if (running.pi) return running.pi;
		if (running.piStarting) return running.piStarting;
		const starting = (async () => {
			const adapter = running.adapter;
			const channel = running.channel;
			const approvalExtension =
				Object.keys(toolConfig.approvalPolicies).length === 0
					? undefined
					: createApprovalExtension({
							config: adapter.approvals ?? {},
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
							const job = currentJob(running);
							const active = running.activeMessage;
							if (!active || !job) return;
							running.todoStatus ??= createStatusSlot({
								adapter: running.adapter,
								message: active,
								thread: channel.activeMessageId(),
							});
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
				store: createFileMemoryStore(running.storage.memoryPath),
			});
			const extensions: ExtensionFactory[] = [];
			if (approvalExtension) extensions.push(approvalExtension);
			if (todo) extensions.push(todo.extension);
			if (memoryExtension) extensions.push(memoryExtension);
			const pi = piHost({
				agent,
				agentDir: staged.agentDir,
				workspaceDir: running.storage.workspaceDir,
				sharedDir: running.storage.sharedDir,
				sessionDir: running.storage.sessionDir,
				extensionPaths: staged.extensionPaths,
				excludeTools: toolConfig.excludeTools,
				customTools: [
					createChatHistoryTool(channel),
					createChatAttachTool({
						workspaceDir: running.storage.workspaceDir,
						sharedDir: running.storage.sharedDir,
						target: () => {
							const active = running.activeMessage;
							if (!active) return undefined;
							return { conversation: active.conversation, thread: channel.activeMessageId() };
						},
						send: (message) => sendLogged(running, message),
					}),
					createChatRequestSecretTool({
						secretDir: running.storage.secretDir,
						manager: secrets,
						target: () => {
							const active = running.activeMessage;
							if (!active) return undefined;
							return { conversation: active.conversation, thread: channel.activeMessageId() };
						},
						send: (message) => sendLogged(running, message),
					}),
					...toolConfig.customTools,
				],
				extensions,
			});
			await pi.start();
			running.pi = pi;
			return pi;
		})();
		running.piStarting = starting;
		try {
			return await starting;
		} finally {
			running.piStarting = undefined;
		}
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
		try {
			await handler(event as never, {
				message,
				job: "job" in event ? event.job : undefined,
				status: running.activity,
				todo: running.todoStatus,
				send: (message) => sendLogged(running, message),
				react: running.adapter.react
					? (emoji) => running.adapter.react?.(message, emoji) ?? Promise.resolve()
					: undefined,
			});
		} catch (error) {
			logger.warn("adapter.event_failed", {
				adapter: running.adapter.id ?? running.adapter.kind,
				event: event.type,
				message: error instanceof Error ? error.message : String(error),
			});
		}
	}

	async function emitMessage(
		running: RunningChannel,
		type: "message.accepted" | "message.queued" | "message.steered" | "message.rejected",
		message: ChatMessage,
	): Promise<void> {
		const handler = eventHandlers(running.adapter)[type];
		if (handler === false || !handler) return;
		try {
			await handler({ type, origin: "heypi", message } as never, {
				message,
				status: running.activity,
				todo: running.todoStatus,
				send: (outbound) => sendLogged(running, outbound),
				react: running.adapter.react
					? (emoji) => running.adapter.react?.(message, emoji) ?? Promise.resolve()
					: undefined,
			});
		} catch (error) {
			logger.warn("adapter.event_failed", {
				adapter: running.adapter.id ?? running.adapter.kind,
				event: type,
				message: error instanceof Error ? error.message : String(error),
			});
		}
	}

	async function dispatch(running: RunningChannel): Promise<void> {
		while (!stopping) {
			const turn = running.channel.next();
			if (!turn) break;
			if (stopping) {
				await running.channel.fail("stopped");
				return;
			}
			const message = turn.message;
			logger.info("turn.start", {
				adapter: message.adapter,
				conversation: message.conversation,
				thread: turn.replyThread,
			});
			let finalText = "";
			let unsubscribe: (() => void) | undefined;
			try {
				running.activeMessage = message;
				running.activity ??= createStatusSlot({ adapter: running.adapter, message, thread: turn.replyThread });
				running.todoStatus = undefined;
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
					const toolEnd = piToolEnd(event);
					if (toolEnd) {
						logger[toolEnd.error ? "warn" : "info"](toolEnd.error ? "pi.tool.error" : "pi.tool.end", {
							adapter: message.adapter,
							conversation: message.conversation,
							thread: turn.replyThread,
							tool: toolEnd.tool,
						});
					}
				});
				await pi.send(turn.prompt);
				await running.activity.wait();
				if (stopping) {
					await running.todo?.cancel();
					await running.activity.clear();
					await running.channel.fail("stopped");
					return;
				}
				await running.todo?.complete();
				const final = finalText.trim();
				const completedJob = currentJob(running);
				if (completedJob)
					await emit(running, { type: "message.completed", origin: "pi", job: completedJob, text: finalText });
				await running.activity.clear();
				if (final) {
					await sendLogged(running, {
						conversation: message.conversation,
						thread: turn.replyThread,
						text: finalText,
					});
				} else if (!running.todoStatus) {
					await sendLogged(running, {
						conversation: message.conversation,
						thread: turn.replyThread,
						text: "Done.",
					});
				}
				await running.channel.complete(finalText);
				logger.info("turn.complete", {
					adapter: message.adapter,
					conversation: message.conversation,
					thread: turn.replyThread,
				});
			} catch (error) {
				const text = error instanceof Error ? error.message : String(error);
				await running.activity?.wait();
				if (stopping || running.canceling) await running.todo?.cancel();
				else await running.todo?.fail();
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
					await running.activity?.clear();
					await sendLogged(running, { conversation: message.conversation, thread: turn.replyThread, text });
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
					await running.activity?.clear();
					await sendLogged(running, {
						conversation: message.conversation,
						thread: turn.replyThread,
						text: failure,
					});
				}
			} finally {
				unsubscribe?.();
				running.activity = undefined;
				running.todoStatus = undefined;
				running.activeMessage = undefined;
			}
		}
		if (!running.idleTimer) {
			running.idleTimer = setTimeout(() => {
				if (running.channel.jobs().length > 0) return;
				void running.pi?.stop().finally(() => {
					running.pi = undefined;
					running.idleTimer = undefined;
				});
			}, IDLE_RUNTIME_TTL_MS);
		}
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
		const storedSecret = await secrets.accept(message.text);
		if (storedSecret) {
			await adapter.send({
				conversation: message.conversation,
				thread: message.thread,
				text: `Secret received and stored as ${storedSecret.name}.`,
			});
			logger.info("secret.received", {
				adapter: message.adapter,
				conversation: message.conversation,
				thread: message.thread,
				name: storedSecret.name,
			});
			return;
		}
		const command = controlCommand(message);
		if (command) {
			const running = await channelFor(adapter, message);
			const jobs = running.channel.jobs();
			if (!canControl(adapter, message, jobs)) {
				await adapter.send({
					conversation: message.conversation,
					thread: message.thread,
					text: "You can only control turns you started.",
				});
				return;
			}
			if (command === "status") {
				const detail =
					jobs.length > 0
						? jobs
								.map(
									(job) =>
										`${job.state}: ${job.thread ?? job.conversation} (${job.actor.name ?? job.actor.id})`,
								)
								.join("\n")
						: "No active or queued turns.";
				await adapter.send({ conversation: message.conversation, thread: message.thread, text: detail });
				return;
			}
			const canceled = await cancelActive(running, "canceled by chat");
			const queued = await running.channel.cancelQueued("canceled by chat");
			await adapter.send({
				conversation: message.conversation,
				thread: message.thread,
				text: canceled || queued ? `Canceled ${canceled + queued} turn(s).` : "No active or queued turns.",
			});
			return;
		}
		const running = await channelFor(adapter, message);
		const prepared = await (adapter.materializeAttachments?.(message, {
			dir: join(running.storage.workspaceDir, "attachments", message.id.replaceAll(/[^a-zA-Z0-9_.-]/g, "_")),
			displayDir: `attachments/${message.id.replaceAll(/[^a-zA-Z0-9_.-]/g, "_")}`,
		}) ?? Promise.resolve(message));
		const result = await running.channel.ingest(prepared, adapter.busy ?? "queue");
		logger.info("adapter.message", {
			adapter: prepared.adapter,
			conversation: prepared.conversation,
			thread: prepared.thread,
			user: prepared.user.id,
			action: result.action,
		});
		if (result.action === "ignored") return;
		if (result.action === "rejected") return emitMessage(running, "message.rejected", prepared);
		if (result.action === "queued") return emitMessage(running, "message.queued", prepared);
		if (result.action === "steer") {
			const active = running.activeMessage;
			if (!active) return emitMessage(running, "message.rejected", prepared);
			const pi = await startPi(running, active);
			if (!pi.steer) return emitMessage(running, "message.rejected", prepared);
			await pi.steer(result.prompt);
			return emitMessage(running, "message.steered", prepared);
		}
		running.activity = createStatusSlot({ adapter: running.adapter, message: prepared, thread: prepared.thread });
		await emitMessage(running, "message.accepted", prepared);
		await dispatch(running);
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
			const adapterNames = adapters.map((adapter) => adapter.id ?? adapter.kind);
			logger.info("app.start", { agent: agent.id, adapters: adapterNames.length, admin: admin?.url() });
			logger.ready?.({ agent: agent.id, adapters: adapterNames, admin: admin?.url() });
		},
		async stop() {
			stopping = true;
			for (const channel of channels.values()) {
				if (channel.idleTimer) clearTimeout(channel.idleTimer);
				await channel.pi?.stop();
				await channel.channel.close();
			}
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
	let stopping = false;
	const stop = (signal: NodeJS.Signals) => {
		if (stopping) return;
		stopping = true;
		void app.stop().finally(() => {
			process.kill(process.pid, signal);
		});
	};
	process.once("SIGINT", stop);
	process.once("SIGTERM", stop);
	return app;
}
