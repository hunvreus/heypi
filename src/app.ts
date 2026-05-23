import type { HeypiConfig } from "./config.js";
import { ActiveRuns } from "./core/active.js";
import { CallRunner } from "./core/calls.js";
import { type Logger, logger, message } from "./core/log.js";
import { createScheduler } from "./core/scheduler.js";
import { splitTools } from "./core-tools.js";
import { runtimeAttachments } from "./io/attachments.js";
import { createHandler, createStatus } from "./io/handler.js";
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
	const attachments = config.attachments?.store ?? runtimeAttachments(runtime, config.attachments);
	const queue = new Queue({
		maxConcurrent: config.runtime.maxConcurrent ?? 12,
		maxPerChat: config.runtime.maxConcurrentPerChat ?? 1,
	});
	const agentTools = splitTools(config.agent.tools);
	const bashConfirm = agentTools.core.find((tool) => tool.name === "bash")?.confirm;
	const callRunner = new CallRunner(
		config.store.calls,
		config.store.approvals,
		queue,
		runtime,
		config.approval,
		log,
		config.store.transaction,
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
		messages: config.store.messages,
		attachments: config.attachments?.process,
		logger: log,
	});
	const handler = createHandler({
		agentId: config.agent.id,
		store: config.store,
		callRunner,
		agent,
		approval: config.approval,
		active,
		lockMs: config.runtime.timeoutMs,
		logger: log,
	});
	const status = createStatus({ agentId: config.agent.id, store: config.store });
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
		await recoverStartup({ agent: config.agent.id, store: config.store, logger: log });
		log.info("app.start", {
			agent: config.agent.id,
			runtime: runtime.name,
			adapters: config.adapters.length,
			jobs: config.jobs?.length ?? 0,
		});
		const started: typeof config.adapters = [];
		try {
			for (const adapter of config.adapters) {
				const start = { handler, status, logger: log, attachments };
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

async function recoverStartup(input: Pick<HeypiConfig, "store"> & { agent: string; logger: Logger }): Promise<void> {
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
