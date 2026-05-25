import { randomUUID } from "node:crypto";
import { hostname } from "node:os";
import type { AppLockConfig, HeypiConfig } from "./config.js";
import { ActiveRuns } from "./core/active.js";
import { CallRunner } from "./core/calls.js";
import { type Logger, logger, message } from "./core/log.js";
import { createScheduler } from "./core/scheduler.js";
import { splitTools } from "./core-tools.js";
import { runtimeAttachments } from "./io/attachments.js";
import { createHandler, createStatus } from "./io/handler.js";
import { createHttpServerRegistry } from "./io/http.js";
import { createRuntime } from "./runtime/index.js";
import { PiAgent } from "./runtime/pi-agent.js";
import { Queue } from "./runtime/queue.js";
import { sqliteStore } from "./store/sqlite.js";
import type { Store } from "./store/types.js";
import { toolRunner } from "./tool-internal.js";

export type HeypiApp = {
	start(): Promise<void>;
	stop(): Promise<void>;
};

type ShutdownSignal = "SIGINT" | "SIGTERM";

const DEFAULT_APP_LOCK_TTL_MS = 60_000;
const DEFAULT_DRAIN_MS = 30_000;

/** Builds a heypi process from code-first config. Starts storage, runtime, handler, and adapters. */
export function createHeypi(config: HeypiConfig): HeypiApp {
	const log = config.logger ?? logger;
	const store = config.store ?? sqliteStore({ path: "./heypi.db" });
	const active = new ActiveRuns();
	const runtime = createRuntime({
		...config.runtime,
		app: process.cwd(),
		agent: config.agent.directory,
	});
	const attachments = config.attachments?.store ?? runtimeAttachments(runtime, config.attachments);
	const queue = new Queue({
		maxConcurrent: config.runtime.maxConcurrent ?? 12,
		maxPerChat: config.runtime.maxConcurrentPerChat ?? 1,
	});
	const agentTools = splitTools(config.agent.tools);
	const bashConfirm = agentTools.core.find((tool) => tool.name === "bash")?.confirm;
	const callRunner = new CallRunner(
		store.calls,
		store.approvals,
		queue,
		runtime,
		config.approval,
		log,
		store.transaction,
		bashConfirm,
	);
	for (const tool of agentTools.custom) {
		const execute = toolRunner(tool);
		if (execute) callRunner.register(tool.name, execute);
	}
	const agent = new PiAgent({
		agent: config.agent,
		callRunner,
		runtime,
		messages: store.messages,
		attachments: config.attachments?.process,
		logger: log,
	});
	const handler = createHandler({
		agentId: config.agent.id,
		store,
		callRunner,
		agent,
		approval: config.approval,
		concurrency: config.concurrency,
		active,
		lockMs: config.runtime.timeoutMs,
		logger: log,
	});
	const status = createStatus({ agentId: config.agent.id, store });
	const starts = new Map();
	const scheduler = createScheduler({
		agent: config.agent.id,
		store,
		handler,
		adapters: config.adapters,
		starts,
		logger: log,
		config: { ...(config.scheduler ?? {}), jobs: config.jobs },
	});
	const appLock = appLockState(config.agent.id, config.appLock);
	validateAdapters(config.adapters);
	const http = createHttpServerRegistry({ logger: log });

	let ready: Promise<void> | undefined;
	let stopping: Promise<void> | undefined;
	async function start(): Promise<void> {
		await store.setup();
		const started: typeof config.adapters = [];
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
				runtime: runtime.name,
				adapters: config.adapters.length,
				jobs: config.jobs?.length ?? 0,
			});
			for (const adapter of config.adapters) {
				const start = { handler, status, logger: log, attachments, http };
				starts.set(adapter, start);
				await adapter.start(start);
				started.push(adapter);
			}
			await http.listen();
			await scheduler?.start();
		} catch (error) {
			await Promise.allSettled(started.reverse().map((adapter) => adapter.stop?.()));
			await http.close();
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
				await Promise.allSettled(config.adapters.map((adapter) => adapter.stop?.()));
				await http.close();
				const drained = await active.drain(appLock.drainMs);
				if (!drained) {
					const cancelled = active.abortAll();
					log.warn("app.drain_cancelled", { agent: config.agent.id, runs: cancelled, reason });
					await active.drain(Math.min(appLock.drainMs, 5_000));
				}
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

function validateAdapters(adapters: HeypiConfig["adapters"]): void {
	const names = new Set<string>();
	for (const adapter of adapters) {
		if (!adapter.name) throw new Error("adapter name is required");
		if (!adapter.kind) throw new Error(`adapter kind is required: ${adapter.name}`);
		if (names.has(adapter.name)) throw new Error(`duplicate adapter name: ${adapter.name}`);
		names.add(adapter.name);
	}
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
	const turns = await input.store.turns.listRunning?.({ agent: input.agent, limit: 500 });
	if (turns?.length) {
		for (const turn of turns) {
			try {
				const result = await input.store.messages.create({
					threadId: turn.threadId,
					provider: turn.provider,
					role: "system",
					actor: "heypi",
					text: "Process restarted while this turn was running.",
					state: "failed",
				});
				await input.store.turns.finish(turn.id, { state: "failed", resultMessageId: result.id });
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
	const locks = await input.store.locks?.clear?.({ prefix: "thread:" });
	if (locks) input.logger.warn("app.recovered_locks", { agent: input.agent, locks });
}
