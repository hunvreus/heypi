import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import type { AgentConfig, ApprovalPolicy, RuntimeConfig } from "./config.js";
import { ActiveRuns } from "./core/active.js";
import { CallRunner } from "./core/calls.js";
import { consoleLogger } from "./core/log.js";
import { DEFAULT_APP_MESSAGES } from "./core/messages.js";
import { splitTools } from "./core-tools.js";
import type { EvalConfig, EvalResult } from "./eval.js";
import { createHandler } from "./io/handler.js";
import { createRuntime, workspace } from "./runtime/index.js";
import { PiAgent } from "./runtime/pi-agent.js";
import { Queue } from "./runtime/queue.js";
import { sqliteStore } from "./store/sqlite.js";
import type { Event, EventType } from "./store/types.js";
import { toolRunner } from "./tool-internal.js";

export type EvalTraceEvent = {
	type: EventType;
	data?: unknown;
	createdAt?: number;
};

export type EvalAgentRunInput = {
	evaluation: Pick<EvalConfig, "name" | "prompt" | "timeoutMs">;
	agent: AgentConfig;
	runtime?: Partial<RuntimeConfig>;
	approval?: ApprovalPolicy;
};

export type EvalAgentRunOutput = EvalResult & {
	trace: string;
	threadId: string;
	events: EvalTraceEvent[];
};

/** Runs one eval prompt through the normal heypi Pi agent path using isolated local state. */
export async function runEvalAgent(input: EvalAgentRunInput): Promise<EvalAgentRunOutput> {
	const root = await mkdtemp(join(tmpdir(), "heypi-eval-"));
	try {
		return await runIsolated(input, root);
	} finally {
		await rm(root, { recursive: true, force: true });
	}
}

async function runIsolated(input: EvalAgentRunInput, root: string): Promise<EvalAgentRunOutput> {
	const store = sqliteStore({ path: join(root, "heypi.db") });
	await store.setup();
	const log = consoleLogger({ level: "error", format: "pretty" });
	const runtimeConfig: RuntimeConfig = {
		name: input.runtime?.name ?? "just-bash",
		root: input.runtime?.root ? resolve(input.runtime.root) : workspace(join(root, "workspace")),
		timeoutMs: input.runtime?.timeoutMs,
		limits: input.runtime?.limits,
		justBash: input.runtime?.justBash,
		hostEnv: input.runtime?.hostEnv,
	};
	const runtime = createRuntime({
		...runtimeConfig,
		app: process.cwd(),
		agent: input.agent.directory,
		runtimeScope: { level: "agent", key: "eval", path: "eval", root: runtimeConfig.root },
	});
	const queue = new Queue({ maxConcurrent: runtimeConfig.maxConcurrent ?? 4, maxPerChat: 1 });
	const active = new ActiveRuns();
	const callRunner = new CallRunner(
		store.calls,
		store.approvals,
		queue,
		() => runtime,
		input.approval,
		log,
		store.transaction,
		undefined,
		DEFAULT_APP_MESSAGES,
		input.agent.id,
		store.approvalBypasses,
		store.events,
	);
	for (const tool of splitTools(input.agent.tools, input.agent.builtinTools).custom) {
		const execute = toolRunner(tool);
		if (execute) callRunner.register(tool.name, execute);
	}
	const agent = new PiAgent({
		agent: input.agent,
		callRunner,
		runtime,
		sessionRuntime: runtime,
		messages: store.messages,
		logger: log,
		appMessages: DEFAULT_APP_MESSAGES,
	});
	const handler = createHandler({
		agentId: input.agent.id,
		store,
		callRunner,
		agent,
		approval: input.approval,
		runtime: () => runtime,
		memoryScope: "channel",
		skillsScope: "channel",
		active,
		logger: log,
	});
	const trace = `eval:${randomUUID()}`;
	const threadKey = evalThreadKey(input.evaluation.name);
	const run = handler({
		provider: "eval",
		kind: "eval",
		eventId: trace,
		channel: threadKey,
		actor: "eval",
		thread: threadKey,
		trace,
		text: input.evaluation.prompt,
	});
	const timeout = input.evaluation.timeoutMs
		? setTimeout(() => active.cancel(trace, "eval"), input.evaluation.timeoutMs)
		: undefined;
	timeout?.unref?.();
	const out = await run.finally(() => {
		if (timeout) clearTimeout(timeout);
	});
	const thread = await store.threads.getByKey(input.agent.id, "eval", undefined, threadKey);
	if (!thread) throw new Error(`eval thread not found: ${input.evaluation.name}`);
	const [calls, approvals, events] = await Promise.all([
		store.calls.listForThread(thread.id, { agent: input.agent.id, limit: 100 }),
		store.approvals.listForThread?.(thread.id, { agent: input.agent.id, limit: 100 }) ?? [],
		store.events?.list({ agent: input.agent.id, trace }) ?? [],
	]);
	return {
		trace,
		threadId: thread.id,
		text: out?.text ?? "",
		tools: unique([...eventTools(events), ...calls.map((row) => row.tool).reverse()]),
		approvals: [...new Set(approvals.map((row) => row.id))].reverse(),
		events: events
			.slice()
			.reverse()
			.map((event) => ({
				type: event.type as EventType,
				data: eventData(event),
				createdAt: event.createdAt,
			})),
	};
}

function evalThreadKey(name: string): string {
	return `eval:${name}`;
}

function eventTools(events: Event[]): string[] {
	const out: string[] = [];
	for (const event of events) {
		if (!event.type.startsWith("tool.")) continue;
		const data = eventData(event) as { tool?: unknown };
		if (typeof data.tool === "string" && data.tool) out.push(data.tool);
	}
	return out;
}

function eventData(event: Event): unknown {
	try {
		return JSON.parse(event.data || "{}") as unknown;
	} catch {
		return {};
	}
}

function unique(input: string[]): string[] {
	return [...new Set(input)];
}
