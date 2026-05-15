import { randomUUID } from "node:crypto";
import type { Adapter, AdapterStart, Handler, Outbound } from "../io/handler.js";
import type { JobConfig, JobSchedule, JobScope, JobTarget } from "../job.js";
import type { DeliveryState, Job, JobRunState, SchedulerStore, Store, Thread } from "../store/types.js";
import type { Logger } from "./log.js";
import { message as errorMessage } from "./log.js";
import { nextAt } from "./schedule.js";

const DEFAULT_POLL_MS = 30_000;
const DEFAULT_LOCK_MS = 10 * 60_000;

export type SchedulerConfig = {
	jobs?: JobConfig[];
	pollMs?: number;
	lockMs?: number;
};

export type Scheduler = {
	start(): Promise<void>;
	stop(): Promise<void>;
};

export function createScheduler(input: {
	agent: string;
	store: Store;
	handler: Handler;
	adapters: Adapter[];
	starts: Map<Adapter, AdapterStart>;
	logger: Logger;
	config?: SchedulerConfig;
}): Scheduler | undefined {
	const jobs = input.config?.jobs ?? [];
	if (!jobs.length) return undefined;
	if (!input.store.jobs || !input.store.jobRuns || !input.store.locks) {
		throw new Error("scheduled jobs require store.jobs, store.jobRuns, and store.locks");
	}
	const store = input.store as SchedulerStore;

	let stopped = false;
	let timer: ReturnType<typeof setTimeout> | undefined;
	const adapters = new Map(input.adapters.map((adapter) => [adapter.name, adapter]));

	async function tick(): Promise<void> {
		const now = Date.now();
		const due = await store.jobs.due(now);
		for (const job of due) await runJob(job, now);
	}

	async function runJob(row: Job | undefined, now: number): Promise<void> {
		if (!row) return;
		const schedule = parseJson<JobSchedule>(row.schedule);
		if (!schedule) throw new Error(`job has invalid schedule: ${row.id}`);
		const scope = parseJson<JobScope | undefined>(row.scope ?? undefined) ?? {};
		const target = parseJson<JobTarget | undefined>(row.target ?? undefined);
		const lockOwner = randomUUID();
		const lock = await store.locks.acquire({
			key: `job:${row.id}`,
			owner: lockOwner,
			ttlMs: input.config?.lockMs ?? DEFAULT_LOCK_MS,
		});
		if (!lock) {
			input.logger.debug("job.locked", { job: row.id });
			return;
		}
		try {
			const targets = await resolveTargets({
				store,
				agent: input.agent,
				kind: row.kind,
				scope,
				target,
			});
			if (!targets.length) {
				input.logger.warn("job.no_target", { job: row.id, kind: row.kind });
				await store.jobs.finish(row.id, { lastAt: now, nextAt: nextAt(schedule, now, row.nextAt) });
				return;
			}
			for (const resolved of targets) await runTarget(row, resolved, schedule, now);
			await finishJob(row.id, { lastAt: now, nextAt: nextAt(schedule, now, row.nextAt) });
		} finally {
			await store.locks.release({ key: `job:${row.id}`, owner: lockOwner });
		}
	}

	async function runTarget(row: Job, resolved: ResolvedTarget, schedule: JobSchedule, dueAt: number): Promise<void> {
		const trace = `job:${row.id}:${dueAt}:${resolved.threadKey}`;
		const run = await store.jobRuns.create({ jobId: row.id, threadId: resolved.thread?.id, trace });
		if (!run.inserted) {
			input.logger.debug("job.duplicate", { job: row.id, trace });
			return;
		}
		input.logger.info("job.start", {
			job: row.id,
			trace,
			kind: row.kind,
			provider: resolved.provider,
			channel: resolved.channel,
		});
		try {
			if (row.kind === "heartbeat" && resolved.thread && !(await idleEnough(store, resolved.thread, row))) {
				await finishRun(run.row.id, {
					state: "skipped",
					deliveryState: "none",
					output: "not idle",
				});
				return;
			}
			const out = await input.handler({
				trace,
				provider: resolved.provider,
				eventId: trace,
				team: resolved.thread?.team || undefined,
				channel: resolved.channel,
				actor: "heypi",
				thread: resolved.threadKey,
				text: row.prompt,
				scheduled: true,
				data: { job: row.id, kind: row.kind, schedule },
			});
			if (!out) {
				await finishRun(run.row.id, {
					state: "skipped",
					deliveryState: "none",
					output: "no output",
				});
				return;
			}
			if (out.silent) {
				await finishRun(run.row.id, { state: "done", deliveryState: "none", output: out.text });
				return;
			}
			await send(resolved, out);
			await finishRun(run.row.id, { state: "done", deliveryState: "delivered", output: out.text });
			input.logger.info("job.done", { job: row.id, trace });
		} catch (error) {
			const msg = errorMessage(error);
			input.logger.error("job.failed", { job: row.id, trace, error: msg });
			await finishRun(run.row.id, { state: "failed", deliveryState: "failed", error: msg });
		}
	}

	async function finishRun(
		id: string,
		result: { state: JobRunState; output?: string; error?: string; deliveryState?: DeliveryState },
	): Promise<void> {
		await transaction(input.store, async (inner) => {
			const store = inner as SchedulerStore;
			await store.jobRuns.finish(id, result);
		});
	}

	async function finishJob(id: string, result: { lastAt: number; nextAt?: number }): Promise<void> {
		await transaction(input.store, async (inner) => {
			const store = inner as SchedulerStore;
			await store.jobs.finish(id, result);
		});
	}

	async function send(target: ResolvedTarget, out: Outbound): Promise<void> {
		const adapter = adapters.get(target.provider);
		if (!adapter?.send) throw new Error(`adapter cannot send scheduled output: ${target.provider}`);
		await adapter.send(target.target, out, input.starts.get(adapter));
	}

	return {
		async start(): Promise<void> {
			stopped = false;
			await installJobs({ agent: input.agent, jobs, store, logger: input.logger });
			const loop = async () => {
				if (stopped) return;
				try {
					await tick();
				} catch (error) {
					input.logger.error("job.tick_failed", { error: errorMessage(error) });
				}
				if (stopped) return;
				timer = setTimeout(loop, input.config?.pollMs ?? DEFAULT_POLL_MS);
			};
			loop();
		},
		async stop(): Promise<void> {
			stopped = true;
			if (timer) clearTimeout(timer);
		},
	};
}

async function installJobs(input: {
	agent: string;
	jobs: JobConfig[];
	store: SchedulerStore;
	logger: Logger;
}): Promise<void> {
	for (const config of input.jobs) {
		const schedule = scheduleOf(config);
		const existing = await input.store.jobs.get(config.id);
		const serialized = JSON.stringify(schedule);
		const next =
			existing?.schedule === serialized && existing.nextAt ? existing.nextAt : nextAt(schedule, Date.now());
		await input.store.jobs.upsert({
			id: config.id,
			agent: input.agent,
			kind: config.kind ?? "cron",
			schedule: serialized,
			scope: config.scope ? JSON.stringify(config.scope) : undefined,
			idleMs: config.idleMs,
			target: config.target ? JSON.stringify(config.target) : undefined,
			prompt: config.prompt,
			state: config.state ?? "active",
			nextAt: next,
		});
		input.logger.debug("job.installed", { job: config.id, nextAt: next });
	}
}

function scheduleOf(job: JobConfig): JobSchedule {
	if (job.schedule && job.everyMs) throw new Error(`job cannot define both schedule and everyMs: ${job.id}`);
	if (job.schedule) return job.schedule;
	if (job.everyMs) return { everyMs: job.everyMs };
	throw new Error(`job requires schedule or everyMs: ${job.id}`);
}

type ResolvedTarget = {
	provider: string;
	channel: string;
	threadKey: string;
	target: JobTarget;
	thread?: Thread;
};

async function resolveTargets(input: {
	store: Store;
	agent: string;
	kind: string;
	scope: JobScope;
	target?: JobTarget;
}): Promise<ResolvedTarget[]> {
	if (input.target) {
		const provider = input.target.adapter ?? input.scope.adapters?.[0];
		const channel = input.target.channel ?? input.target.user;
		if (!provider || !channel) return [];
		return [
			{
				provider,
				channel,
				threadKey: `${channel}:${input.target.thread ?? channel}`,
				target: input.target,
			},
		];
	}
	const threads = await input.store.threads.list({
		agent: input.agent,
		providers: input.scope.adapters,
		teams: input.scope.teams,
		channels: input.scope.channels,
		users: input.scope.users,
	});
	if (input.kind !== "heartbeat" && threads.length !== 1) return [];
	return threads.map((thread) => ({
		provider: thread.provider,
		channel: thread.channel,
		threadKey: thread.key,
		target: { adapter: thread.provider, channel: thread.channel, thread: targetThread(thread) },
		thread,
	}));
}

async function idleEnough(store: Store, thread: Thread, row: { idleMs: number | null }): Promise<boolean> {
	if (!row.idleMs) return true;
	const messages = await store.messages.listForThread(thread.id, { limit: 1 });
	const last = messages[0]?.createdAt ?? thread.createdAt;
	return Date.now() - last >= row.idleMs;
}

function targetThread(thread: Thread): string | undefined {
	const suffix = thread.key.startsWith(`${thread.channel}:`) ? thread.key.slice(thread.channel.length + 1) : undefined;
	return suffix && suffix !== thread.channel ? suffix : undefined;
}

function parseJson<T>(input?: string): T | undefined {
	if (!input) return undefined;
	return JSON.parse(input) as T;
}

async function transaction<T>(store: Store, fn: (store: Store) => Promise<T>): Promise<T> {
	return store.transaction ? store.transaction(fn) : fn(store);
}
