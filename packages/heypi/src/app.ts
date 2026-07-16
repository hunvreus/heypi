import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import type { ExtensionFactory } from "@earendil-works/pi-coding-agent";
import { createAdmin } from "./admin.js";
import { stageAgent } from "./agent.js";
import { createApprovalExtension } from "./approval.js";
import { type Channel, createChannel, type Turn } from "./channel.js";
import { createChatAttachTool, createChatHistoryTool, createChatRequestSecretTool } from "./chat-tools.js";
import type { AdapterEvent, ChatJob, TurnCause } from "./events.js";
import { consoleLogger } from "./log.js";
import { createFileMemoryStore, createMemoryExtension } from "./memory.js";
import { createMessageSlot, type MessageSlot } from "./message-slot.js";
import { createPiHost, type PiEvent, type PiHost, type PiHostOptions } from "./pi.js";
import { createReplyIndex, type ReplyIndex } from "./replies.js";
import { type LoadedSchedule, loadSchedules, type ScheduleDispatch } from "./schedule.js";
import { createScheduleStore, type ScheduleRun } from "./schedule-store.js";
import { createScheduler, type ScheduleInfo, type Scheduler } from "./scheduler.js";
import { createSecretManager, type SecretManager } from "./secrets.js";
import {
	type ChatAddress,
	type ChatStorage,
	ensureChatStorage,
	executionKey,
	storageForAddress,
	storageSegment,
	userMemoryDir,
} from "./storage.js";
import { createTodoController, renderTodo, type TodoController } from "./todo.js";
import { toolSettings } from "./tool-config.js";
import type { Adapter, AgentConfig, ApprovalDecision, ChatMessage, Logger, SendMessage, SentMessage } from "./types.js";

export type HeypiApp = {
	start(): Promise<void>;
	stop(): Promise<void>;
	jobs(): ChatJob[];
	cancelQueued(reason?: string): Promise<number>;
	cancelActive(reason?: string): Promise<number>;
	schedules: {
		list(): ScheduleInfo[];
		run(id: string): Promise<ScheduleRun>;
		runs(id?: string): ScheduleRun[];
	};
};

export type CreateHeypiOptions = {
	agent: AgentConfig | Promise<AgentConfig>;
	adapters: Adapter[];
	logger?: Logger;
	piHost?: PiHostFactory;
};

export type PiHostFactory = (options: PiHostOptions) => PiHost;

type RunningChannel = {
	address: ChatAddress;
	channel: Channel;
	adapter: Adapter;
	pi?: PiHost;
	piStarting?: Promise<PiHost>;
	piStopping?: Promise<void>;
	storage: ChatStorage;
	todoMessage?: MessageSlot;
	activeMessage?: ChatMessage;
	activeTurn?: Turn;
	todo?: TodoController;
	canceling?: string;
	abort?: AbortController;
	idleTimer?: ReturnType<typeof setTimeout>;
	dispatching?: Promise<void>;
};

const IDLE_RUNTIME_TTL_MS = 10 * 60 * 1000;

function appendUrl(base: string, suffix: string): string {
	return `${base.replace(/\/$/, "")}/${suffix.replace(/^\//, "")}`;
}

function keyFor(message: ChatAddress): string {
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

function actorAllowed(allow: Adapter["allow"], message: ChatMessage): boolean {
	if (message.user.isBot) return true;
	if (!allow?.users && !allow?.groups) return true;
	if (allow.users?.includes(message.user.id)) return true;
	return Boolean(message.user.groups?.some((group) => allow.groups?.includes(group)));
}

function allowed(adapter: Adapter, message: ChatMessage): boolean {
	const allow = adapter.allow;
	if (!botAllowed(allow, message)) return false;
	if (!allow) return true;
	if (message.dm && allow.dms === false) return false;
	if (!message.dm && !includes(allow.channels, message.channel ?? message.conversation)) return false;
	return actorAllowed(allow, message);
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
	const adapterIds = new Set<string>();
	for (const adapter of options.adapters) {
		const id = adapter.id ?? adapter.kind;
		if (adapterIds.has(id)) throw new Error(`Duplicate adapter ID: ${id}`);
		adapterIds.add(id);
	}
	const logger = options.logger ?? consoleLogger;
	const piHost = options.piHost ?? createPiHost;
	const stateDir = agent.state?.dir ?? join(process.cwd(), ".heypi");
	const toolConfig = toolSettings(agent);
	const staged = await stageAgent(agent, stateDir);
	const scheduleDefinitions = await loadSchedules(agent.root);
	const scheduleStore = createScheduleStore(join(stateDir, "schedules", "state.json"));
	const channels = new Map<string, RunningChannel>();
	const loadingChannels = new Map<string, Promise<RunningChannel>>();
	const replyIndexes = new Map<string, Promise<ReplyIndex>>();
	const resourceQueues = new Map<string, Promise<void>>();
	let scheduler: Scheduler;
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
				schedules: {
					list: () => scheduler.list(),
					run: (id) => scheduler.run(id),
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
	const intakes = new Set<Promise<void>>();

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
		const queuedJobs =
			scope === "queued" || scope === "all"
				? (await Promise.all([...channels.values()].map((running) => running.channel.cancelQueued(reason)))).flat()
				: [];
		await settleCanceledScheduleJobs(queuedJobs, reason ?? "canceled");
		const queued = queuedJobs.length;
		return { active, queued };
	}

	async function channelForAddress(adapter: Adapter, address: ChatAddress): Promise<RunningChannel> {
		const key = keyFor(address);
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
		const storage = storageForAddress(agent, stateDir, address);
		const loadingChannel = (async () => {
			await ensureChatStorage(storage);
			const channel = createChannel({ logPath: storage.logPath, lockPath: storage.lockPath });
			await channel.load();
			const running = { address, adapter, channel, storage };
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

	async function channelFor(adapter: Adapter, message: ChatMessage): Promise<RunningChannel> {
		return channelForAddress(adapter, message);
	}

	async function replyIndex(message: Pick<ChatMessage, "adapter" | "adapterId" | "conversation">) {
		const key = `${message.adapterId}:${message.conversation}`;
		let loading = replyIndexes.get(key);
		if (!loading) {
			loading = (async () => {
				const storage = storageForAddress(agent, stateDir, message);
				const index = createReplyIndex(storage.repliesPath);
				await index.load();
				return index;
			})();
			replyIndexes.set(key, loading);
			void loading.catch(() => {
				if (replyIndexes.get(key) === loading) replyIndexes.delete(key);
			});
		}
		return loading;
	}

	function sentIds(sent: SentMessage | undefined): string[] {
		return [...new Set([sent?.id, ...(sent?.ids ?? [])].filter((id): id is string => Boolean(id)))];
	}

	async function registerReplies(
		adapter: Adapter,
		address: Pick<ChatMessage, "adapter" | "adapterId" | "conversation" | "session">,
		sent: SentMessage | undefined,
	): Promise<void> {
		if (!address.session || adapter.kind === "slack") return;
		const session = address.session;
		const ids = sentIds(sent);
		if (ids.length === 0) return;
		const index = await replyIndex(address);
		await Promise.all(ids.map((id) => index.add(id, session)));
	}

	async function routeMessage(message: ChatMessage): Promise<ChatMessage | undefined> {
		if (message.dm || message.session) return message;
		if (message.replyTo) {
			const session = (await replyIndex(message)).resolve(message.replyTo);
			if (session) return { ...message, session };
		}
		if (!message.mentioned) return undefined;
		return { ...message, session: message.id };
	}

	async function sendLogged(running: RunningChannel, message: SendMessage): Promise<SentMessage | undefined> {
		const sent = await running.adapter.send(message);
		await running.channel.outbound(message, sent?.id);
		await registerReplies(running.adapter, running.address, sent);
		return sent;
	}

	async function sendDirect(adapter: Adapter, source: ChatMessage, message: SendMessage): Promise<void> {
		const sent = await adapter.send(message);
		await registerReplies(adapter, source, sent);
	}

	function inResourceQueue<T>(resources: string[], operation: () => Promise<T>): Promise<T> {
		const keys = [...new Set(resources)].sort();
		const previous = Promise.all(keys.map((key) => resourceQueues.get(key) ?? Promise.resolve()));
		const task = previous.then(operation);
		const tail = task.then(
			() => undefined,
			() => undefined,
		);
		for (const key of keys) resourceQueues.set(key, tail);
		return task.finally(() => {
			for (const key of keys) if (resourceQueues.get(key) === tail) resourceQueues.delete(key);
		});
	}

	async function startPi(running: RunningChannel, turn: Turn): Promise<PiHost> {
		if (stopping) throw new Error("application is stopping");
		if (running.idleTimer) {
			clearTimeout(running.idleTimer);
			running.idleTimer = undefined;
		}
		await running.piStopping;
		if (stopping) throw new Error("application is stopping");
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
							context: () => {
								const active = running.activeTurn ?? turn;
								return {
									turnId: active.id,
									triggerRecord: active.triggerRecord,
									inboundMessageId: active.cause.kind === "message" ? active.cause.messageId : undefined,
									adapter: active.adapter,
									adapterId: active.adapterId,
									conversation: active.conversation,
									thread: active.replyThread,
									replyTo: active.replyTo,
									actor: active.actor,
								};
							},
							audit: {
								requested: (input) => channel.approvalRequested(input),
								resolved: (input) => channel.approvalResolved(input),
								annotationFailed(error) {
									logger.warn("approval_annotation_failed", {
										message: error instanceof Error ? error.message : String(error),
									});
								},
							},
							request: async (view) => {
								const active = running.activeTurn ?? turn;
								const decision: ApprovalDecision = await (adapter.requestApproval?.(
									{
										...view,
										conversation: active.conversation,
										thread: active.replyThread,
										replyTo: active.replyTo,
									},
									running.abort?.signal,
								) ??
									Promise.resolve({
										approved: false,
										reason: `${adapter.kind} adapter cannot approve tools.`,
									}));
								await registerReplies(adapter, running.address, { ids: decision.messageIds });
								return decision;
							},
						});
			const todo = todoEnabled(agent)
				? createTodoController({
						render: async (update) => {
							const job = currentJob(running);
							const active = running.activeTurn;
							if (!active || !job || !running.activeMessage) return;
							running.todoMessage ??= createMessageSlot({
								adapter: running.adapter,
								target: {
									conversation: active.conversation,
									thread: active.replyThread,
									replyTo: active.replyTo,
								},
								onSent: (sent) => registerReplies(running.adapter, running.address, sent),
							});
							await emit(running, {
								type: "todo_changed",
								origin: "heypi",
								job,
								text: renderTodo(update),
							});
						},
					})
				: undefined;
			running.todo = todo;
			const memoryExtension =
				agent.memory === false
					? undefined
					: createMemoryExtension({
							store(destination) {
								if (destination === "conversation") {
									return createFileMemoryStore(running.storage.memoryDir, "memory");
								}
								if (destination === "shared") {
									return createFileMemoryStore(running.storage.sharedMemoryDir, "memory");
								}
								const active = running.activeMessage;
								if (!active) throw new Error("User memory requires an active chat user.");
								return createFileMemoryStore(userMemoryDir(running.storage, active.user.id), "user");
							},
							source: () => {
								const active = running.activeMessage;
								if (!active) return undefined;
								return {
									adapter: active.adapter,
									adapterId: active.adapterId,
									conversation: active.conversation,
									user: active.user.id,
								};
							},
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
							const active = running.activeTurn;
							if (!active) return undefined;
							return {
								conversation: active.conversation,
								thread: active.replyThread,
								replyTo: active.replyTo,
							};
						},
						send: (message) => sendLogged(running, message),
					}),
					createChatRequestSecretTool({
						secretDir: running.storage.secretDir,
						manager: secrets,
						target: () => {
							const active = running.activeTurn;
							if (!active) return undefined;
							return {
								conversation: active.conversation,
								thread: active.replyThread,
								replyTo: active.replyTo,
							};
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
		running.abort?.abort(reason);
		await running.pi.abort();
		return 1;
	}

	async function emit(running: RunningChannel, event: AdapterEvent): Promise<void> {
		const handler = running.adapter.events?.[event.type];
		if (handler === false || !handler) return;
		const message = "message" in event ? event.message : running.activeMessage;
		if (!message) return;
		try {
			await handler(event as never, {
				message,
				job: "job" in event ? event.job : undefined,
				todo: running.todoMessage,
				send: (message) => sendLogged(running, message),
			});
		} catch (error) {
			logger.warn("adapter_event_failed", {
				adapter: running.adapter.id ?? running.adapter.kind,
				event: event.type,
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
				await settleScheduledTurn(turn, "canceled", undefined, "application stopped");
				return;
			}
			logger.info("turn_started", {
				adapter: turn.adapter,
				conversation: turn.conversation,
				thread: turn.replyThread,
				cause: turn.cause.kind,
			});
			let finalText = "";
			let unsubscribe: (() => void) | undefined;
			try {
				running.abort = new AbortController();
				running.activeMessage = turn.message;
				running.activeTurn = turn;
				running.todoMessage = undefined;
				const pi = await startPi(running, turn);
				running.todo?.reset();
				const job = currentJob(running);
				if (job) await emit(running, { type: "turn_started", origin: "pi", job });
				unsubscribe = pi.subscribe((event) => {
					if (event.type === "message_end" && event.message.role === "assistant") {
						finalText = assistantText(event.message);
					}
					const toolName = piToolName(event);
					if (toolName) {
						logger.info("pi_tool_started", {
							adapter: turn.adapter,
							conversation: turn.conversation,
							thread: turn.replyThread,
							tool: toolName,
						});
						const job = currentJob(running);
						if (job) void emit(running, { type: "tool_started", origin: "pi", job, tool: toolName });
					}
					const toolEnd = piToolEnd(event);
					if (toolEnd) {
						logger[toolEnd.error ? "warn" : "info"](toolEnd.error ? "pi_tool_failed" : "pi_tool_completed", {
							adapter: turn.adapter,
							conversation: turn.conversation,
							thread: turn.replyThread,
							tool: toolEnd.tool,
						});
					}
				});
				await pi.send(turn.prompt);
				if (stopping) {
					await running.todo?.cancel();
					await running.channel.fail("stopped");
					await settleScheduledTurn(turn, "canceled", undefined, "application stopped");
					return;
				}
				await running.todo?.complete();
				const final = finalText.trim();
				if (final) {
					await sendLogged(running, {
						conversation: turn.conversation,
						thread: turn.replyThread,
						replyTo: turn.replyTo,
						text: finalText,
					});
				} else if (!running.todoMessage) {
					await sendLogged(running, {
						conversation: turn.conversation,
						thread: turn.replyThread,
						replyTo: turn.replyTo,
						text: "Done.",
					});
				}
				const completedJob = currentJob(running);
				if (completedJob)
					await emit(running, { type: "message_completed", origin: "pi", job: completedJob, text: finalText });
				await running.channel.complete(finalText);
				await settleScheduledTurn(turn, "completed", finalText);
				logger.info("turn_completed", {
					adapter: turn.adapter,
					conversation: turn.conversation,
					thread: turn.replyThread,
				});
			} catch (error) {
				const text = error instanceof Error ? error.message : String(error);
				if (stopping || running.canceling) await running.todo?.cancel();
				else await running.todo?.fail();
				const canceled = running.canceling;
				const job = currentJob(running);
				if (canceled) {
					if (job) await emit(running, { type: "turn_canceled", origin: "heypi", job, reason: canceled });
					await running.channel.cancelActive(canceled);
					await settleScheduledTurn(turn, "canceled", undefined, canceled);
					logger.info("turn_canceled", {
						adapter: turn.adapter,
						conversation: turn.conversation,
						thread: turn.replyThread,
						reason: canceled,
					});
					if (!stopping) {
						const text = canceled === "canceled" ? "Canceled." : `Canceled: ${canceled}`;
						await sendLogged(running, {
							conversation: turn.conversation,
							thread: turn.replyThread,
							replyTo: turn.replyTo,
							text,
						});
					}
				} else {
					if (job) await emit(running, { type: "turn_failed", origin: "heypi", job, error: text });
					await running.channel.fail(text);
					await settleScheduledTurn(turn, "failed", undefined, text);
					logger.error("turn_failed", {
						adapter: turn.adapter,
						conversation: turn.conversation,
						thread: turn.replyThread,
						message: text,
					});
				}
				running.canceling = undefined;
				if (stopping) return;
				if (!canceled) {
					const failure = `The agent failed: ${text}`;
					await sendLogged(running, {
						conversation: turn.conversation,
						thread: turn.replyThread,
						replyTo: turn.replyTo,
						text: failure,
					});
				}
			} finally {
				unsubscribe?.();
				running.abort = undefined;
				running.todoMessage = undefined;
				running.activeMessage = undefined;
				running.activeTurn = undefined;
			}
		}
		if (!stopping && !running.idleTimer) {
			running.idleTimer = setTimeout(() => {
				if (running.channel.jobs().length > 0) return;
				const pi = running.pi;
				running.pi = undefined;
				running.idleTimer = undefined;
				if (!pi) return;
				const stopping = pi
					.stop()
					.catch((error) => {
						logger.warn("runtime_stop_failed", {
							trigger: "idle",
							message: error instanceof Error ? error.message : String(error),
						});
					})
					.finally(() => {
						if (running.piStopping === stopping) running.piStopping = undefined;
					});
				running.piStopping = stopping;
				void stopping;
			}, IDLE_RUNTIME_TTL_MS);
		}
	}

	function runDispatch(running: RunningChannel): Promise<void> {
		if (running.dispatching) return running.dispatching;
		const task = inResourceQueue([running.storage.workspaceDir, running.storage.sharedDir], () =>
			dispatch(running),
		).finally(() => {
			if (running.dispatching === task) running.dispatching = undefined;
		});
		running.dispatching = task;
		return task;
	}

	async function settleScheduledTurn(
		turn: Turn,
		status: "completed" | "failed" | "canceled",
		output?: string,
		error?: string,
	): Promise<void> {
		await settleScheduleCause(turn.cause, status, output, error);
	}

	async function settleCanceledScheduleJobs(jobs: ChatJob[], reason: string): Promise<void> {
		await Promise.all(jobs.map((job) => settleScheduleCause(job.cause, "canceled", undefined, reason)));
	}

	async function settleScheduleCause(
		cause: TurnCause,
		status: "completed" | "failed" | "canceled",
		output?: string,
		error?: string,
	): Promise<void> {
		if (cause.kind !== "schedule") return;
		const scheduleId = cause.scheduleId;
		const runId = cause.runId;
		try {
			await scheduleStore.update(runId, {
				status,
				output: output?.trim() || undefined,
				error,
				finishedAt: new Date().toISOString(),
			});
		} catch (failure) {
			logger.error("schedule_audit_failed", {
				schedule: scheduleId,
				run: runId,
				message: failure instanceof Error ? failure.message : String(failure),
			});
		}
	}

	async function receive(adapter: Adapter, message: ChatMessage, waitForTurn = true): Promise<void> {
		if (stopping) return;
		let resolveIntake: () => void = () => undefined;
		const intake = new Promise<void>((resolve) => {
			resolveIntake = resolve;
		});
		intakes.add(intake);
		const finishIntake = () => {
			if (!intakes.delete(intake)) return;
			resolveIntake();
		};
		let accepted = false;
		try {
			if (message.user.isSelf) {
				logger.debug("adapter_message_ignored", {
					adapter: message.adapter,
					conversation: message.conversation,
					user: message.user.id,
					reason: "self",
				});
				return;
			}
			if (!allowed(adapter, message)) {
				logger.warn("adapter_message_denied", {
					adapter: message.adapter,
					adapterId: message.adapterId,
					conversation: message.conversation,
					user: message.user.id,
				});
				return;
			}
			const routed = await routeMessage(message);
			if (!routed) return;
			message = routed;
			const storedSecret = await secrets.accept(message.text);
			if (storedSecret) {
				await sendDirect(adapter, message, {
					conversation: message.conversation,
					thread: message.thread,
					replyTo: message.dm ? undefined : message.id,
					text: `Secret received and stored as ${storedSecret.name}.`,
				});
				logger.info("secret_received", {
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
					await sendDirect(adapter, message, {
						conversation: message.conversation,
						thread: message.thread,
						replyTo: message.dm ? undefined : message.id,
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
					await sendDirect(adapter, message, {
						conversation: message.conversation,
						thread: message.thread,
						replyTo: message.dm ? undefined : message.id,
						text: detail,
					});
					return;
				}
				const canceled = await cancelActive(running, "canceled by chat");
				const queuedJobs = await running.channel.cancelQueued("canceled by chat");
				await settleCanceledScheduleJobs(queuedJobs, "canceled by chat");
				const queued = queuedJobs.length;
				await sendDirect(adapter, message, {
					conversation: message.conversation,
					thread: message.thread,
					replyTo: message.dm ? undefined : message.id,
					text: canceled || queued ? `Canceled ${canceled + queued} turn(s).` : "No active or queued turns.",
				});
				return;
			}
			const running = await channelFor(adapter, message);
			accepted = running.channel.accepts(message);
			if (accepted) await emit(running, { type: "message_accepted", origin: "heypi", message });
			const busy = adapter.busy ?? "queue";
			const prepared = accepted
				? await (adapter.materializeAttachments?.(message, {
						dir: join(
							running.storage.workspaceDir,
							"attachments",
							message.id.replaceAll(/[^a-zA-Z0-9_.-]/g, "_"),
						),
						displayDir: `attachments/${message.id.replaceAll(/[^a-zA-Z0-9_.-]/g, "_")}`,
					}) ?? Promise.resolve(message))
				: message;
			const mode = busy === "steer" && prepared.attachments?.length ? "queue" : busy;
			const result = await running.channel.ingest(prepared, mode);
			logger.info("adapter_message", {
				adapter: prepared.adapter,
				conversation: prepared.conversation,
				thread: prepared.thread,
				user: prepared.user.id,
				action: result.action,
			});
			if (result.action === "ignored") return;
			if (result.action === "rejected")
				return emit(running, { type: "message_rejected", origin: "heypi", message: prepared });
			if (result.action === "queued")
				return emit(running, { type: "message_queued", origin: "heypi", message: prepared });
			if (result.action === "steer") {
				const active = running.activeTurn;
				if (!active) return emit(running, { type: "message_rejected", origin: "heypi", message: prepared });
				const pi = await startPi(running, active);
				if (!pi.steer) return emit(running, { type: "message_rejected", origin: "heypi", message: prepared });
				await pi.steer(result.prompt);
				return emit(running, { type: "message_steered", origin: "heypi", message: prepared });
			}
			finishIntake();
			const dispatching = runDispatch(running);
			if (waitForTurn) await dispatching;
			else
				void dispatching.catch((error) => {
					logger.error("turn_dispatch_failed", {
						adapter: message.adapter,
						conversation: message.conversation,
						thread: message.thread,
						message: error instanceof Error ? error.message : String(error),
					});
				});
		} catch (error) {
			if (accepted) {
				const text = error instanceof Error ? error.message : String(error);
				const running = channels.get(keyFor(message));
				if (running) await emit(running, { type: "message_failed", origin: "heypi", message, error: text });
			}
			throw error;
		} finally {
			finishIntake();
		}
	}

	function adapterById(id: string): Adapter {
		const matches = options.adapters.filter((adapter) => (adapter.id ?? adapter.kind) === id);
		if (matches.length !== 1) throw new Error(`Schedule target must resolve to one adapter: ${id}`);
		return matches[0];
	}

	async function dispatchSchedule(input: ScheduleDispatch, run: ScheduleRun): Promise<{ jobId: string }> {
		if (stopping) throw new Error("application is stopping");
		const adapter = adapterById(input.target.adapterId);
		const address: ChatAddress = {
			adapter: adapter.kind,
			adapterId: input.target.adapterId,
			conversation: input.target.conversation,
			thread: input.target.thread,
		};
		const running = await channelForAddress(adapter, address);
		const accepted = await running.channel.trigger({
			...address,
			prompt: input.prompt,
			actor: { id: `schedule:${run.scheduleId}`, name: run.scheduleId },
			cause: {
				kind: "schedule",
				scheduleId: run.scheduleId,
				runId: run.id,
				scheduledFor: run.scheduledFor,
			},
		});
		if (accepted.action === "started") {
			void runDispatch(running).catch((error) => {
				logger.error("schedule_dispatch_failed", {
					schedule: run.scheduleId,
					run: run.id,
					message: error instanceof Error ? error.message : String(error),
				});
			});
		}
		return { jobId: accepted.id };
	}

	async function executeSchedulePrompt(
		schedule: LoadedSchedule,
		run: ScheduleRun,
		signal: AbortSignal,
	): Promise<{ output?: string; sessionId?: string }> {
		if (schedule.definition.prompt === undefined) throw new Error(`Schedule ${schedule.id} has no prompt.`);
		const root = join(stateDir, "schedules", storageSegment(schedule.id));
		const workspaceDir = join(root, "workspace");
		const sessionDir = join(root, "runs", run.id, "session");
		await mkdir(workspaceDir, { recursive: true });
		await mkdir(sessionDir, { recursive: true });
		const approvalExtension =
			Object.keys(toolConfig.approvalPolicies).length === 0
				? undefined
				: createApprovalExtension({
						policies: toolConfig.approvalPolicies,
						context: () => ({}),
						request: async () => ({
							approved: false,
							reason: "Background schedules cannot wait for interactive approval.",
						}),
					});
		const pi = piHost({
			agent,
			agentDir: staged.agentDir,
			workspaceDir,
			sessionDir,
			extensionPaths: staged.extensionPaths,
			excludeTools: toolConfig.excludeTools,
			customTools: toolConfig.customTools,
			extensions: approvalExtension ? [approvalExtension] : [],
			mode: "background",
		});
		let finalText = "";
		let unsubscribe: (() => void) | undefined;
		const abort = () => void pi.abort?.();
		try {
			if (signal.aborted) throw new Error("schedule canceled");
			signal.addEventListener("abort", abort, { once: true });
			await pi.start();
			if (signal.aborted) {
				await pi.abort?.();
				throw new Error("schedule canceled");
			}
			unsubscribe = pi.subscribe((event) => {
				if (event.type === "message_end" && event.message.role === "assistant") {
					finalText = assistantText(event.message);
				}
			});
			await pi.send(schedule.definition.prompt);
			return { output: finalText.trim() || undefined, sessionId: run.id };
		} finally {
			signal.removeEventListener("abort", abort);
			unsubscribe?.();
			await pi.stop();
		}
	}

	scheduler = createScheduler({
		definitions: scheduleDefinitions,
		store: scheduleStore,
		logger,
		dispatch: dispatchSchedule,
		executePrompt: executeSchedulePrompt,
	});

	return {
		async start() {
			stopping = false;
			if (!agent.runtime) {
				logger.warn("security_runtime_unisolated", {
					reason: "runtime omitted; shell commands execute on the host",
				});
			}
			const adapters = options.adapters;
			if (Object.keys(toolConfig.approvalPolicies).length > 0) {
				for (const adapter of adapters) {
					if (adapter.requestApproval && !adapter.admins && !adapter.approvers) {
						logger.warn("security_approval_unrestricted", {
							adapter: adapter.id ?? adapter.kind,
							reason: "tool approvals can be resolved by any actor who can reach the approval UI",
						});
					}
				}
			}
			const startedAdapters: Adapter[] = [];
			let adminStarted = false;
			try {
				await admin?.start();
				adminStarted = Boolean(admin);
				if (admin) logger.info("admin_started", { url: admin.url() });
				for (const adapter of adapters) {
					startedAdapters.push(adapter);
					await adapter.start({
						agentId: agent.id,
						logger,
						enqueue: (message) => receive(adapter, message, false),
						receive: (message) => receive(adapter, message),
					});
				}
				await scheduler.start();
			} catch (error) {
				await scheduler.stop().catch(() => undefined);
				for (const adapter of startedAdapters.reverse()) {
					try {
						await adapter.stop?.();
					} catch {}
				}
				if (adminStarted) await admin?.stop().catch(() => undefined);
				throw error;
			}
			const adapterNames = adapters.map((adapter) => adapter.id ?? adapter.kind);
			logger.info("app_started", { agent: agent.id, adapters: adapterNames.length, admin: admin?.url() });
			logger.ready?.({ agent: agent.id, adapters: adapterNames, admin: admin?.url() });
		},
		async stop() {
			stopping = true;
			const failures: unknown[] = [];
			const attempt = async (step: string, operation: () => Promise<void>): Promise<void> => {
				try {
					await operation();
				} catch (error) {
					failures.push(error);
					logger.warn("app_stop_step_failed", {
						step,
						message: error instanceof Error ? error.message : String(error),
					});
				}
			};
			await attempt("scheduler", () => scheduler.stop());
			await Promise.all([...intakes]);
			const runningChannels = [...channels.values()];

			await Promise.all(
				runningChannels.map(async (channel) => {
					if (channel.idleTimer) clearTimeout(channel.idleTimer);
					let queued: ChatJob[] = [];
					await attempt("channel_cancel_queued", async () => {
						queued = await channel.channel.cancelQueued("application stopped");
					});
					await attempt("schedule_cancel_queued", () => settleCanceledScheduleJobs(queued, "application stopped"));
					if (!channel.dispatching) return;
					channel.canceling = "application stopped";
					channel.abort?.abort("application stopped");
					let pi = channel.pi;
					if (!pi && channel.piStarting) {
						try {
							pi = await channel.piStarting;
						} catch {}
					}
					if (pi?.abort) await attempt("runtime_abort", () => pi.abort?.() ?? Promise.resolve());
				}),
			);

			await Promise.all(
				runningChannels.map((channel) => attempt("turn_drain", () => channel.dispatching ?? Promise.resolve())),
			);
			await Promise.all(
				runningChannels.map(async (channel) => {
					if (channel.pi) await attempt("runtime_stop", () => channel.pi?.stop() ?? Promise.resolve());
					if (channel.piStopping)
						await attempt("runtime_idle_stop", () => channel.piStopping ?? Promise.resolve());
					await attempt("channel_close", () => channel.channel.close());
				}),
			);
			await Promise.all(
				options.adapters.map((adapter) =>
					adapter.stop
						? attempt(`adapter.${adapter.id ?? adapter.kind}`, () => adapter.stop?.() ?? Promise.resolve())
						: undefined,
				),
			);
			if (admin) await attempt("admin", () => admin.stop());
			logger.info("app_stopped", { agent: agent.id });
			if (failures.length) throw new AggregateError(failures, "Application shutdown failed");
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
		schedules: {
			list: () => scheduler.list(),
			run: (id) => scheduler.run(id),
			runs: (id) => scheduler.runs(id),
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
