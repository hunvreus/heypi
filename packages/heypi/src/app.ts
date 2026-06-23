import { randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import { hostname } from "node:os";
import { join } from "node:path";
import { createAdminAdapter } from "./admin/index.js";
import type { AppLockConfig, ApprovalPolicy, HeypiConfig, HttpConfig } from "./config.js";
import { ActiveRuns } from "./core/active.js";
import { actorLabels, hasActorPolicy, mergeActorPolicies } from "./core/approvers.js";
import { CallRunner } from "./core/calls.js";
import { type Logger, logger, message } from "./core/log.js";
import { Memory, normalizeMemoryConfig } from "./core/memory.js";
import { normalizeMessages } from "./core/messages.js";
import { createScheduler } from "./core/scheduler.js";
import { ScopedRuntimeRegistry } from "./core/scope.js";
import {
	normalizeSecretsConfig,
	Secrets,
	secretCss,
	secretPage,
	secretRoute,
	secretStyleRoute,
} from "./core/secrets.js";
import { normalizeSkillsConfig, Skills } from "./core/skills.js";
import { splitTools } from "./core-tools.js";
import { runtimeAttachments } from "./io/attachments.js";
import { type Adapter, type AdapterStart, createHandler, createStatus } from "./io/handler.js";
import { createHttpServerRegistry } from "./io/http.js";
import { local } from "./io/local.js";
import { createRuntime } from "./runtime/index.js";
import { PiAgent } from "./runtime/pi-agent.js";
import { Queue } from "./runtime/queue.js";
import { normalizeStateRoot } from "./state.js";
import { sqliteStore } from "./store/sqlite.js";
import type { Store } from "./store/types.js";
import { toolConfirm, toolRunner } from "./tool-internal.js";

export type HeypiApp = {
	start(): Promise<void>;
	stop(): Promise<void>;
};

type ShutdownSignal = "SIGINT" | "SIGTERM";

const DEFAULT_APP_LOCK_TTL_MS = 60_000;
const DEFAULT_DRAIN_MS = 30_000;
const DEFAULT_HTTP: Required<HttpConfig> = { host: "127.0.0.1", port: 3000 };
const DEFAULT_ADMIN_HTTP: Required<HttpConfig> = { host: "127.0.0.1", port: 4321 };
const TOP_LEVEL_CONFIG_KEYS = new Set([
	"store",
	"state",
	"adapters",
	"agent",
	"runtime",
	"http",
	"admin",
	"attachments",
	"approval",
	"task",
	"scope",
	"memory",
	"skills",
	"secrets",
	"messages",
	"appLock",
	"scheduler",
	"jobs",
	"logger",
]);
const APPROVAL_CONFIG_KEYS = new Set(["expiresInMs", "allowSelfApproval", "bypass"]);

/** Builds a heypi process from code-first config. Starts storage, runtime, handler, and adapters. */
export function createHeypi(config: HeypiConfig): HeypiApp {
	const cwd = process.cwd();
	const log = config.logger ?? logger;
	validateConfigShape(config, log);
	const jobs = config.jobs ?? config.agent.jobs;
	config.runtime.provider?.setLogger?.(log);
	const messages = normalizeMessages(config.messages);
	const devMode = process.env.HEYPI_INTERNAL_DEV === "1";
	const httpConfig = normalizeHttpConfig(config.http);
	const configuredAdmin = config.admin ?? (devMode ? { auth: false } : undefined);
	const rawAdminConfig = configuredAdmin === true ? {} : configuredAdmin === false ? undefined : configuredAdmin;
	const adminHttpConfig = normalizeHttpConfig(rawAdminConfig?.http, DEFAULT_ADMIN_HTTP);
	const stateRoot = normalizeStateRoot(config.state);
	mkdirSync(stateRoot, { recursive: true });
	validateUserAdapters(config.adapters);
	const devAdapter = shouldEnableDevAdapter(config.adapters) ? local() : undefined;
	if (devAdapter && !loopbackHost(adminHttpConfig.host)) {
		throw new Error("heypi dev requires a loopback admin HTTP host for local test routes");
	}
	const runtimeAdapters = devAdapter ? [...config.adapters, devAdapter] : config.adapters;
	const adminAdapter = rawAdminConfig
		? createAdminAdapter(rawAdminConfig ?? {}, adminHttpConfig, {
				root: stateRoot,
				agent: config.agent.id,
				project: cwd,
			})
		: undefined;
	const lifecycleAdapters = adminAdapter ? [...runtimeAdapters, adminAdapter] : runtimeAdapters;
	validateAdapterNames(lifecycleAdapters);
	const store = config.store ?? sqliteStore({ path: join(stateRoot, "heypi.db") });
	const active = new ActiveRuns();
	const appRuntime = createRuntime({
		...config.runtime,
		app: cwd,
		agent: config.agent.directory,
		runtimeScope: { level: "agent", key: "app", path: "app", root: config.runtime.root },
	});
	const runtimes = new ScopedRuntimeRegistry(config.runtime, { app: cwd, agent: config.agent.directory });
	const runtime = (scope?: string) => runtimes.getPath(scope);
	const approvalActors = collectApprovalActors(config);
	const memoryConfig = normalizeMemoryConfig(config.memory, {
		scope: config.scope,
		approvers: hasActorPolicy(approvalActors) ? actorLabels(approvalActors) : [],
	});
	const memory = new Memory(config.runtime.root, memoryConfig);
	const skillsConfig = normalizeSkillsConfig(config.skills, {
		scope: config.scope,
		approvers: hasActorPolicy(approvalActors) ? actorLabels(approvalActors) : [],
	});
	const skills = new Skills(config.runtime.root, skillsConfig);
	const secretsConfig = normalizeSecretsConfig(config.secrets);
	const secrets = new Secrets(secretsConfig);
	const attachments = config.attachments?.store ?? runtimeAttachments(appRuntime, config.attachments);
	const queue = new Queue({
		maxConcurrent: config.runtime.maxConcurrent ?? 12,
		maxPerChat: config.runtime.maxConcurrentPerChat ?? 1,
	});
	const agentTools = splitTools(config.agent.tools, config.agent.builtinTools);
	const bashConfirm = agentTools.core.find((tool) => tool.name === "bash")?.confirm;
	warnSecurityPosture({
		logger: log,
		agent: config.agent.id,
		runtime: appRuntime.name,
		http: httpConfig,
		approval: config.approval,
		approvalActorsConfigured: hasActorPolicy(approvalActors),
		botInputAdapters: runtimeAdapters.filter((adapter) => adapter.acceptsBots).map((adapter) => adapter.name),
		bashEnabled: agentTools.core.some((tool) => tool.name === "bash"),
		confirmedCustomTools: agentTools.custom.filter((tool) => toolConfirm(tool)).map((tool) => tool.name),
	});
	const callRunner = new CallRunner(
		store.calls,
		store.approvals,
		queue,
		runtime,
		config.approval,
		log,
		store.transaction,
		bashConfirm,
		messages,
		config.agent.id,
		store.approvalBypasses,
		store.events,
	);
	for (const tool of agentTools.custom) {
		const execute = toolRunner(tool);
		if (execute) callRunner.register(tool.name, execute);
	}
	const agent = new PiAgent({
		agent: config.agent,
		callRunner,
		runtime,
		sessionRuntime: appRuntime,
		attachmentRuntime: appRuntime,
		messages: store.messages,
		attachments: config.attachments?.process,
		memory,
		skills,
		secrets,
		approvalApprovers: approvalActors,
		logger: log,
		appMessages: messages,
	});
	const handler = createHandler({
		agentId: config.agent.id,
		store,
		callRunner,
		agent,
		approval: config.approval,
		task: config.task,
		scope: config.scope,
		runtimeScope: config.runtime.scope,
		memoryScope: memoryConfig.scope,
		skillsScope: skillsConfig.scope,
		secrets,
		runtime,
		messages,
		active,
		lockMs: config.runtime.timeoutMs,
		logger: log,
	});
	const status = createStatus({ agentId: config.agent.id, store });
	const starts = new Map<Adapter, AdapterStart>();
	const scheduler = createScheduler({
		agent: config.agent.id,
		store,
		handler,
		adapters: runtimeAdapters,
		starts,
		logger: log,
		config: { ...(config.scheduler ?? {}), jobs },
	});
	const appLock = appLockState(config.agent.id, config.appLock);
	const http = createHttpServerRegistry({ logger: log, listen: httpConfig });
	const adminHttp = createHttpServerRegistry({ logger: log, listen: adminHttpConfig });
	if (secretsConfig.enabled && secretsConfig.serve) {
		http.register({
			method: "GET",
			path: secretRoute(secretsConfig.url),
			handler: (_req, res) => {
				res.writeHead(200, {
					"content-type": "text/html; charset=utf-8",
					"cache-control": "no-store",
					"x-content-type-options": "nosniff",
				});
				res.end(secretPage());
			},
		});
		http.register({
			method: "GET",
			path: secretStyleRoute(secretsConfig.url),
			handler: (_req, res) => {
				res.writeHead(200, {
					"content-type": "text/css; charset=utf-8",
					"cache-control": "no-store",
					"x-content-type-options": "nosniff",
				});
				res.end(secretCss());
			},
		});
	}
	let appStartedAt = Date.now();

	let ready: Promise<void> | undefined;
	let stopping: Promise<void> | undefined;
	async function start(): Promise<void> {
		await store.setup();
		const started: Adapter[] = [];
		let locked = false;
		try {
			await acquireAppLock({
				lock: appLock,
				store,
				logger: log,
				onLost: () => {
					log.error("app.lock_lost_shutdown", { agent: config.agent.id });
					void shutdown("lock_lost");
				},
			});
			locked = appLock.enabled;
			await recoverStartup({ agent: config.agent.id, store, logger: log });
			log.info("app.start", {
				agent: config.agent.id,
				runtime: appRuntime.name,
				adapters: runtimeAdapters.length,
				admin: adminAdapter !== undefined,
				jobs: jobs?.length ?? 0,
			});
			appStartedAt = Date.now();
			if (memoryConfig.enabled) {
				const level = memoryConfig.scope === "adapter" || memoryConfig.scope === "agent" ? "warn" : "info";
				log[level]("memory.enabled", {
					agent: config.agent.id,
					scope: memoryConfig.scope,
					writePolicy: memoryConfig.writePolicy,
				});
			}
			if (skillsConfig.enabled) {
				const level = skillsConfig.writePolicy === "off" ? "warn" : "info";
				log[level]("skills.enabled", {
					agent: config.agent.id,
					scope: skillsConfig.scope,
					writePolicy: skillsConfig.writePolicy,
				});
			}
			if (secretsConfig.enabled) {
				log.info("secrets.enabled", {
					agent: config.agent.id,
					url: secretsConfig.url,
					serve: secretsConfig.serve,
				});
			}
			const internalAdapters = [devAdapter, adminAdapter].filter(
				(adapter): adapter is Adapter => adapter !== undefined,
			);
			const startAdapter = async (adapter: Adapter) => {
				const adapterApproval = approvalForAdapter(config.approval, adapter);
				const adapterHandler =
					adapter === adminAdapter
						? handler
						: createHandler({
								agentId: config.agent.id,
								store,
								callRunner,
								agent,
								approval: adapterApproval,
								task: config.task,
								scope: config.scope,
								runtimeScope: config.runtime.scope,
								memoryScope: memoryConfig.scope,
								skillsScope: skillsConfig.scope,
								secrets,
								runtime,
								messages,
								active,
								lockMs: config.runtime.timeoutMs,
								logger: log,
							});
				const start = {
					handler: adapterHandler,
					status,
					logger: log,
					messages,
					attachments,
					http: adapter === adminAdapter || adapter === devAdapter ? adminHttp : http,
					store,
					approval: adapterApproval,
					memory,
					app: {
						agent: config.agent.id,
						agentDirectory: config.agent.directory,
						agentModel: config.agent.model,
						runtime: { name: appRuntime.name, root: config.runtime.root },
						state: { root: stateRoot },
						task: normalizeTaskConfig(config.task),
						approval: config.approval,
						memory: memoryConfig,
						skills: skillsConfig,
						adapters: runtimeAdapters.map((item) => ({
							name: item.name,
							kind: item.kind,
							permissions: item.permissions,
						})),
						evals: config.agent.evals ?? [],
						startedAt: appStartedAt,
					},
				} satisfies AdapterStart;
				starts.set(adapter, start);
				await adapter.start(start);
				started.push(adapter);
			};
			for (const adapter of internalAdapters) {
				await startAdapter(adapter);
			}
			await adminHttp.listen();
			for (const adapter of internalAdapters) {
				const start = starts.get(adapter);
				if (start) await adapter.ready?.(start);
			}
			for (const adapter of config.adapters) {
				await startAdapter(adapter);
			}
			await http.listen();
			for (const adapter of config.adapters) {
				const start = starts.get(adapter);
				if (start) await adapter.ready?.(start);
			}
			await scheduler?.start();
		} catch (error) {
			await Promise.allSettled(started.reverse().map((adapter) => adapter.stop?.()));
			await Promise.allSettled([http.close(), adminHttp.close()]);
			await runtimes.close();
			for (const adapter of started) starts.delete(adapter);
			if (locked) await releaseAppLock({ lock: appLock, store });
			ready = undefined;
			throw error;
		}
	}
	function ensureStarted(): Promise<void> {
		ready ??= start();
		return ready;
	}
	async function shutdown(reason: "stop" | "lock_lost"): Promise<void> {
		if (stopping) return await stopping;
		stopping = (async () => {
			log.info("app.stop", { agent: config.agent.id, reason });
			try {
				await scheduler?.stop();
				await Promise.allSettled([http.close(), adminHttp.close()]);
				const drained = await active.drain(appLock.drainMs);
				if (!drained) {
					const cancelled = active.abortAll();
					log.warn("app.drain_cancelled", { agent: config.agent.id, runs: cancelled, reason });
					await active.drain(Math.min(appLock.drainMs, 5_000));
				}
				const scheduledDrained = await scheduler?.drain(Math.min(appLock.drainMs, 5_000));
				if (scheduledDrained === false) {
					log.warn("app.scheduler_drain_timeout", { agent: config.agent.id, reason });
				}
				await Promise.allSettled(lifecycleAdapters.map((adapter) => adapter.stop?.()));
				await runtimes.close();
			} finally {
				starts.clear();
				await releaseAppLock({ lock: appLock, store });
				ready = undefined;
			}
		})();
		try {
			await stopping;
		} finally {
			stopping = undefined;
		}
	}

	return {
		async start(): Promise<void> {
			await ensureStarted();
		},
		async stop(): Promise<void> {
			await shutdown("stop");
		},
	};
}

/** Starts an app and installs process signal handlers that stop it before exit. */
export async function runHeypi(app: HeypiApp): Promise<void> {
	let stopping = false;
	const shutdown = (signal: ShutdownSignal) => {
		if (stopping) {
			process.exit(signalExitCode(signal));
		}
		stopping = true;
		void app
			.stop()
			.catch((error) => {
				console.error(error);
				process.exitCode = 1;
			})
			.finally(() => process.exit(process.exitCode ?? 0));
	};
	process.once("SIGINT", shutdown);
	process.once("SIGTERM", shutdown);
	try {
		await app.start();
	} catch (error) {
		process.off("SIGINT", shutdown);
		process.off("SIGTERM", shutdown);
		throw error;
	}
}

function validateUserAdapters(adapters: HeypiConfig["adapters"]): void {
	const names = new Set<string>();
	for (const adapter of adapters) {
		if (!adapter.name) throw new Error("adapter name is required");
		if (!adapter.kind) throw new Error(`adapter kind is required: ${adapter.name}`);
		if (adapter.name.toLowerCase() === "admin") throw new Error("adapter name is reserved: admin");
		if (names.has(adapter.name)) throw new Error(`duplicate adapter name: ${adapter.name}`);
		names.add(adapter.name);
	}
}

function shouldEnableDevAdapter(adapters: HeypiConfig["adapters"]): boolean {
	return process.env.HEYPI_INTERNAL_DEV === "1" && !adapters.some((adapter) => adapter.name === "local");
}

function validateAdapterNames(adapters: HeypiConfig["adapters"]): void {
	const names = new Set<string>();
	for (const adapter of adapters) {
		if (names.has(adapter.name)) throw new Error(`duplicate adapter name: ${adapter.name}`);
		names.add(adapter.name);
	}
}

function validateConfigShape(config: HeypiConfig, log: Logger): void {
	warnUnknownKeys(log, "config", config as Record<string, unknown>, TOP_LEVEL_CONFIG_KEYS);
	const approval = config.approval as Record<string, unknown> | undefined;
	if (!approval) return;
	if (typeof approval !== "object" || Array.isArray(approval)) throw new Error("approval must be an object");
	if ("approvers" in approval || "admins" in approval) {
		throw new Error(
			"approval.approvers/admins moved to adapter.permissions; set permissions: { approvers, admins } on each adapter",
		);
	}
	warnUnknownKeys(log, "config.approval", approval, APPROVAL_CONFIG_KEYS);
}

function warnUnknownKeys(log: Logger, path: string, input: Record<string, unknown>, allowed: Set<string>): void {
	for (const key of Object.keys(input)) {
		if (!allowed.has(key)) log.warn("config.unknown_key", { path: `${path}.${key}` });
	}
}

function normalizeHttpConfig(
	config: HttpConfig | undefined,
	defaults: Required<HttpConfig> = DEFAULT_HTTP,
): Required<HttpConfig> {
	return {
		host: config?.host ?? defaults.host,
		port: config?.port ?? defaults.port,
	};
}

function warnSecurityPosture(input: {
	logger: Logger;
	agent: string;
	runtime: string;
	http: Required<HttpConfig>;
	approval: HeypiConfig["approval"];
	approvalActorsConfigured: boolean;
	botInputAdapters: string[];
	bashEnabled: boolean;
	confirmedCustomTools: string[];
}): void {
	if (input.runtime === "host-bash" || input.runtime === "guarded-bash") {
		input.logger.warn("security.runtime_host", {
			agent: input.agent,
			runtime: input.runtime,
			reason: "host runtimes execute as the heypi process user; use only for trusted local or admin apps",
		});
	}
	if (!loopbackHost(input.http.host)) {
		input.logger.warn("security.http_public", {
			agent: input.agent,
			host: input.http.host,
			port: input.http.port,
			reason: "non-loopback HTTP listeners should be behind TLS, authentication, and rate limits",
		});
	}
	if (!input.approvalActorsConfigured && (input.bashEnabled || input.confirmedCustomTools.length > 0)) {
		input.logger.warn("security.approvers_missing", {
			agent: input.agent,
			bash: input.bashEnabled,
			tools: input.confirmedCustomTools.join(","),
			reason:
				"without adapter permissions approvers or admins, approval visibility controls who can approve risky calls",
		});
	}
	if (
		input.botInputAdapters.length > 0 &&
		!input.approvalActorsConfigured &&
		(input.bashEnabled || input.confirmedCustomTools.length > 0)
	) {
		input.logger.warn("security.bot_approvers_missing", {
			agent: input.agent,
			adapters: input.botInputAdapters.join(","),
			reason:
				"allow.bots accepts bot messages, but bots cannot resolve approvals unless explicitly listed in adapter permissions",
		});
	}
}

function approvalForAdapter(base: HeypiConfig["approval"], adapter: Adapter): ApprovalPolicy {
	return {
		...base,
		approvers: adapter.permissions?.approvers,
		admins: adapter.permissions?.admins,
	};
}

function collectApprovalActors(config: HeypiConfig) {
	return mergeActorPolicies(
		...config.adapters.flatMap((adapter) => [adapter.permissions?.approvers, adapter.permissions?.admins]),
	);
}

function normalizeTaskConfig(input: HeypiConfig["task"]): Required<NonNullable<HeypiConfig["task"]>> {
	return {
		busy: input?.busy ?? "steer",
		cancel: input?.cancel ?? "initiator",
	};
}

function loopbackHost(host: string): boolean {
	const normalized = host.toLowerCase().replace(/^\[/u, "").replace(/\]$/u, "");
	return normalized === "localhost" || normalized === "127.0.0.1" || normalized === "::1";
}

type AppLockState = {
	enabled: boolean;
	key: string;
	owner: string;
	ttlMs: number;
	drainMs: number;
	timer?: ReturnType<typeof setInterval>;
};

function appLockState(agent: string, config: false | AppLockConfig | undefined): AppLockState {
	const enabled = config !== false;
	const ttlMs = enabled ? (config?.ttlMs ?? DEFAULT_APP_LOCK_TTL_MS) : DEFAULT_APP_LOCK_TTL_MS;
	return {
		enabled,
		key: `app:${agent}`,
		owner: `${hostname()}:${process.pid}:${randomUUID()}`,
		ttlMs,
		drainMs: enabled ? (config?.drainMs ?? DEFAULT_DRAIN_MS) : DEFAULT_DRAIN_MS,
	};
}

async function acquireAppLock(input: {
	lock: AppLockState;
	store: Store;
	logger: Logger;
	onLost: () => void;
}): Promise<void> {
	if (!input.lock.enabled) return;
	if (!input.store.locks) throw new Error("heypi app lock requires store.locks; set appLock: false to disable it");
	const acquired = await input.store.locks.acquire({
		key: input.lock.key,
		owner: input.lock.owner,
		ttlMs: input.lock.ttlMs,
	});
	if (!acquired) {
		const current = await input.store.locks.get(input.lock.key);
		if (current && sameHostDeadOwner(current.owner)) {
			await input.store.locks.release({ key: input.lock.key, owner: current.owner });
			input.logger.warn("app.lock_stale_released", {
				key: input.lock.key,
				owner: current.owner,
				expiresAt: current.expiresAt,
			});
			const retry = await input.store.locks.acquire({
				key: input.lock.key,
				owner: input.lock.owner,
				ttlMs: input.lock.ttlMs,
			});
			if (retry) {
				startAppLockRefresh(input);
				return;
			}
		}
		input.logger.error("app.locked", {
			key: input.lock.key,
			owner: current?.owner,
			expiresAt: current?.expiresAt,
		});
		throw new Error(
			[
				`heypi app lock is held: ${input.lock.key}`,
				current?.owner ? `owner=${current.owner}` : undefined,
				current?.expiresAt ? `expiresAt=${new Date(current.expiresAt).toISOString()}` : undefined,
			]
				.filter(Boolean)
				.join(" "),
		);
	}
	startAppLockRefresh(input);
}

function startAppLockRefresh(input: { lock: AppLockState; store: Store; logger: Logger; onLost: () => void }): void {
	const refreshMs = Math.max(10, Math.floor(input.lock.ttlMs / 3));
	input.lock.timer = setInterval(() => {
		void input.store.locks
			?.refresh({ key: input.lock.key, owner: input.lock.owner, ttlMs: input.lock.ttlMs })
			.then((row) => {
				if (!row) {
					input.logger.error("app.lock_refresh_lost", { key: input.lock.key, owner: input.lock.owner });
					input.onLost();
				}
			})
			.catch((error) => input.logger.error("app.lock_refresh_failed", { error: message(error) }));
	}, refreshMs);
	input.lock.timer.unref?.();
}

function sameHostDeadOwner(owner: string): boolean {
	const parsed = parseLockOwner(owner);
	return Boolean(parsed && parsed.host === hostname() && !pidAlive(parsed.pid));
}

function parseLockOwner(owner: string): { host: string; pid: number } | undefined {
	const [host, rawPid] = owner.split(":");
	const pid = Number(rawPid);
	if (!host || !Number.isInteger(pid) || pid <= 0) return undefined;
	return { host, pid };
}

function pidAlive(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch (error) {
		return (error as NodeJS.ErrnoException).code === "EPERM";
	}
}

function signalExitCode(signal: ShutdownSignal): number {
	return signal === "SIGINT" ? 130 : 143;
}

async function releaseAppLock(input: { lock: AppLockState; store: Store }): Promise<void> {
	if (input.lock.timer) {
		clearInterval(input.lock.timer);
		input.lock.timer = undefined;
	}
	if (!input.lock.enabled || !input.store.locks) return;
	await input.store.locks.release({ key: input.lock.key, owner: input.lock.owner });
}

async function recoverStartup(input: { store: Store; agent: string; logger: Logger }): Promise<void> {
	const restartMessage = "Process restarted while this work was running.";
	const turns = await input.store.turns.listRunning?.({ agent: input.agent, limit: 500 });
	const recoveredThreads = new Set<string>();
	if (turns?.length) {
		for (const turn of turns) {
			try {
				const result = await input.store.messages.create({
					threadId: turn.threadId,
					provider: turn.provider,
					role: "system",
					actor: "heypi",
					text: restartMessage,
					state: "failed",
				});
				await input.store.turns.finish(turn.id, { state: "failed", resultMessageId: result.id });
				if (turn.trace) {
					await appendRecoveryEvent(input, {
						trace: turn.trace,
						threadId: turn.threadId,
						turnId: turn.id,
						type: "message.sent",
						data: { messageId: result.id, role: "system", state: "failed", reason: restartMessage },
					});
					await appendRecoveryEvent(input, {
						trace: turn.trace,
						threadId: turn.threadId,
						turnId: turn.id,
						type: "turn.failed",
						data: { reason: restartMessage, resultMessageId: result.id },
					});
				}
				recoveredThreads.add(turn.threadId);
			} catch (error) {
				input.logger.warn("app.recovery_turn_failed", {
					agent: input.agent,
					turn: turn.id,
					error: message(error),
				});
			}
		}
		input.logger.warn("app.recovered_turns", { agent: input.agent, turns: turns.length });
	}
	let locks = 0;
	for (const threadId of recoveredThreads) {
		if (!input.store.locks?.clear) {
			input.logger.warn("app.recovery_locks_unsupported", {
				agent: input.agent,
				threads: recoveredThreads.size,
			});
			break;
		}
		locks += await input.store.locks.clear({ key: `thread:${threadId}` });
	}
	if (locks) input.logger.warn("app.recovered_locks", { agent: input.agent, locks });
	const runningCalls = await (input.store.calls.listRecent?.({
		agent: input.agent,
		states: ["running"],
		limit: 500,
	}) ?? []);
	if (input.store.calls.failRunning) {
		const calls = await input.store.calls.failRunning({ agent: input.agent, error: restartMessage });
		if (calls) {
			for (const call of runningCalls) {
				if (!call.trace) continue;
				await appendRecoveryEvent(input, {
					trace: call.trace,
					threadId: call.threadId ?? undefined,
					turnId: call.turnId ?? undefined,
					callId: call.id,
					type: "tool.failed",
					data: { tool: call.tool, state: "failed", reason: restartMessage },
				});
			}
			input.logger.warn("app.recovered_calls", { agent: input.agent, calls });
		}
	} else {
		input.logger.warn("app.recovery_calls_unsupported", { agent: input.agent });
	}
	if (input.store.jobRuns) {
		if (input.store.jobRuns.requeueRunning) {
			const jobRuns = await input.store.jobRuns.requeueRunning({ agent: input.agent, error: restartMessage });
			if (jobRuns) input.logger.warn("app.requeued_job_runs", { agent: input.agent, jobRuns });
		} else if (input.store.jobRuns.failRunning) {
			const jobRuns = await input.store.jobRuns.failRunning({ agent: input.agent, error: restartMessage });
			if (jobRuns) input.logger.warn("app.recovered_job_runs", { agent: input.agent, jobRuns });
		} else {
			input.logger.warn("app.recovery_job_runs_unsupported", { agent: input.agent });
		}
	}
}

async function appendRecoveryEvent(
	input: { store: Store; agent: string; logger: Logger },
	event: {
		trace: string;
		type: "message.sent" | "turn.failed" | "tool.failed";
		data?: unknown;
		threadId?: string;
		turnId?: string;
		callId?: string;
	},
): Promise<void> {
	try {
		await input.store.events?.append({ agent: input.agent, ...event });
	} catch (error) {
		input.logger.warn("app.recovery_event_failed", {
			agent: input.agent,
			trace: event.trace,
			type: event.type,
			error: message(error),
		});
	}
}
