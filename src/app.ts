import type { HeypiConfig } from "./config.js";
import { ActiveRuns } from "./core/active.js";
import { CallRunner } from "./core/calls.js";
import { logger } from "./core/log.js";
import { createScheduler } from "./core/scheduler.js";
import { runtimeAttachments } from "./io/attachments.js";
import { createHandler } from "./io/handler.js";
import { createRuntime } from "./runtime/index.js";
import { PiAgent } from "./runtime/pi-agent.js";
import { Queue } from "./runtime/queue.js";
import { toolRunner } from "./tool-internal.js";

export type HeypiApp = {
	start(): Promise<void>;
	stop(): Promise<void>;
};

/** Builds a heypi process from code-first config. Starts storage, runtime, handler, and adapters. */
export function createHeypi(config: HeypiConfig): HeypiApp {
	const log = config.logger ?? logger;
	const active = new ActiveRuns();
	const runtime = createRuntime({
		...config.runtime,
		app: process.cwd(),
		agent: config.agent.directory,
	});
	const attachments = config.attachments ?? runtimeAttachments(runtime, config.attachment);
	const queue = new Queue({
		maxConcurrent: config.runtime.maxConcurrent ?? 12,
		maxPerChat: config.runtime.maxConcurrentPerChat ?? 1,
	});
	const callRunner = new CallRunner(
		config.store.calls,
		config.store.approvals,
		queue,
		runtime,
		config.approval,
		log,
		config.store.transaction,
		config.policy?.command,
	);
	for (const tool of config.agent.tools ?? []) {
		const execute = toolRunner(tool);
		if (execute) callRunner.register(tool.name, execute);
	}
	const agent = new PiAgent({
		agent: config.agent,
		callRunner,
		runtime,
		messages: config.store.messages,
		sessions: config.store.sessions,
		logger: log,
	});
	const handler = createHandler({
		agentId: config.agent.id,
		store: config.store,
		callRunner,
		agent,
		active,
		logger: log,
	});
	const starts = new Map();
	const scheduler = createScheduler({
		agent: config.agent.id,
		store: config.store,
		handler,
		adapters: config.adapters,
		starts,
		logger: log,
		config: { ...(config.scheduler ?? {}), jobs: config.jobs },
	});

	let ready: Promise<void> | undefined;
	async function start(): Promise<void> {
		await config.store.setup();
		log.info("app.start", {
			agent: config.agent.id,
			runtime: runtime.name,
			adapters: config.adapters.length,
			jobs: config.jobs?.length ?? 0,
		});
		const started: typeof config.adapters = [];
		try {
			for (const adapter of config.adapters) {
				const start = { handler, logger: log, attachments };
				starts.set(adapter, start);
				await adapter.start(start);
				started.push(adapter);
			}
			await scheduler?.start();
		} catch (error) {
			await Promise.allSettled(started.reverse().map((adapter) => adapter.stop?.()));
			for (const adapter of started) starts.delete(adapter);
			ready = undefined;
			throw error;
		}
	}
	function ensureStarted(): Promise<void> {
		ready ??= start();
		return ready;
	}

	return {
		async start(): Promise<void> {
			await ensureStarted();
		},
		async stop(): Promise<void> {
			log.info("app.stop", { agent: config.agent.id });
			await scheduler?.stop();
			await Promise.allSettled(config.adapters.map((adapter) => adapter.stop?.()));
			starts.clear();
			ready = undefined;
		},
	};
}
