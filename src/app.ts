import type { HeypiConfig } from "./config.js";
import { ActiveRuns } from "./core/active.js";
import { CallRunner } from "./core/calls.js";
import { logger } from "./core/log.js";
import type { ToolExecute } from "./core/types.js";
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
	const attachments = config.attachments ?? runtimeAttachments(runtime);
	const queue = new Queue({
		maxConcurrent: config.runtime.maxConcurrent ?? 12,
		maxPerChat: config.runtime.maxConcurrentPerChat ?? 1,
	});
	const callRunner = new CallRunner(config.store.calls, config.store.approvals, queue, runtime, config.approval, log);
	for (const tool of config.agent.tools ?? []) {
		const execute = replay(tool);
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

	return {
		async start(): Promise<void> {
			await config.store.setup();
			log.info("app.start", {
				agent: config.agent.id,
				runtime: runtime.name,
				adapters: config.adapters.length,
			});
			await Promise.all(config.adapters.map((adapter) => adapter.start({ handler, logger: log, attachments })));
		},
		async stop(): Promise<void> {
			log.info("app.stop", { agent: config.agent.id });
			await Promise.all(config.adapters.map((adapter) => adapter.stop?.()));
		},
	};
}

function replay(tool: unknown): ToolExecute | undefined {
	return toolRunner(tool);
}
