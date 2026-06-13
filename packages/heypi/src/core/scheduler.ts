import { randomUUID } from "node:crypto";
import type { Adapter, AdapterStart, AdapterTarget, Handler, Outbound } from "../io/handler.js";
import type { JobConfig, JobSchedule, JobScope, JobTarget, JobTargets } from "../job.js";
import { transaction } from "../store/transaction.js";
import type { DeliveryState, Job, JobRun, JobRunState, SchedulerStore, Store, Thread } from "../store/types.js";
import type { Logger } from "./log.js";
import { message as errorMessage, logger } from "./log.js";
import { nextAt } from "./schedule.js";

const DEFAULT_POLL_MS = 30_000;
const DEFAULT_LOCK_MS = 10 * 60_000;
const DEFAULT_MAX_CONCURRENT_RUNS = 1;

export type SchedulerConfig = {
	jobs?: JobConfig[];
	pollMs?: number;
	lockMs?: number;
	maxConcurrentRuns?: number;
};

export type Scheduler = {
	start(): Promise<void>;
	stop(): Promise<void>;
};

type QueueJobRuns = SchedulerStore["jobRuns"] & {
	claim: NonNullable<SchedulerStore["jobRuns"]["claim"]>;
	hasActiveTarget: NonNullable<SchedulerStore["jobRuns"]["hasActiveTarget"]>;
};

type QueueSchedulerStore = SchedulerStore & { jobRuns: QueueJobRuns };

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
	if (!input.store.jobRuns.claim || !input.store.jobRuns.hasActiveTarget) {
		throw new Error("scheduled jobs require store.jobRuns claim and active-target support");
	}
	const store = input.store as QueueSchedulerStore;

	let stopped = false;
	let timer: ReturnType<typeof setTimeout> | undefined;
	let tickPromise: Promise<void> | undefined;
	const adapters = new Map(input.adapters.map((adapter) => [adapter.name, adapter]));
	const owner = `scheduler:${input.agent}:${randomUUID()}`;
	const activeRuns = new Set<Promise<void>>();

	async function tick(): Promise<void> {
		const now = Date.now();
		const due = await store.jobs.due({ agent: input.agent, now });
		for (const job of due) {
			if (stopped) return;
			await materializeJob(job, now);
		}
		if (stopped) return;
		await claimRuns(now);
	}

	async function materializeJob(row: Job | undefined, now: number): Promise<void> {
		if (!row) return;
		const parsed = parseJob(row);
		if (!parsed.ok) {
			input.logger.error("job.invalid_config", {
				agent: row.agent,
				job: row.id,
				field: parsed.field,
				error: parsed.error,
			});
			await store.jobs.setState({ agent: row.agent, id: row.id }, "paused");
			return;
		}
		const { schedule } = parsed;
		const lockOwner = randomUUID();
		const lockKey = `job:${row.agent}:${row.id}`;
		const lock = await store.locks.acquire({
			key: lockKey,
			owner: lockOwner,
			ttlMs: input.config?.lockMs ?? DEFAULT_LOCK_MS,
		});
		if (!lock) {
			input.logger.debug("job.locked", { job: row.id });
			return;
		}
		try {
			await transaction(input.store, async (inner) => {
				const tx = inner as SchedulerStore;
				const result = await enqueueJobRuns({
					agent: input.agent,
					store: tx,
					job: row,
					dueAt: now,
					logger: input.logger,
					skipActiveHeartbeat: true,
				});
				if (!result.targets) input.logger.warn("job.no_target", { job: row.id, kind: row.kind });
				await tx.jobs.finish({ agent: row.agent, id: row.id }, finishResult(schedule, now, row.nextAt));
			});
		} finally {
			await store.locks.release({ key: lockKey, owner: lockOwner });
		}
	}

	async function claimRuns(now: number): Promise<void> {
		const limit = input.config?.maxConcurrentRuns ?? DEFAULT_MAX_CONCURRENT_RUNS;
		const slots = Math.max(0, limit - activeRuns.size);
		if (!slots) return;
		const claimed = await store.jobRuns.claim({ agent: input.agent, owner, now, limit: slots });
		for (const run of claimed) {
			const task = executeRun(run).finally(() => activeRuns.delete(task));
			activeRuns.add(task);
		}
	}

	async function executeRun(run: JobRun): Promise<void> {
		const row = await store.jobs.get({ agent: run.jobAgent, id: run.jobId });
		if (!row) {
			await finishRun(run.id, {
				state: "skipped",
				deliveryState: "none",
				output: "job removed",
			});
			return;
		}
		const parsed = parseJob(row);
		if (!parsed.ok) {
			input.logger.error("job.invalid_config", {
				agent: row.agent,
				job: row.id,
				field: parsed.field,
				error: parsed.error,
			});
			await store.jobs.setState({ agent: row.agent, id: row.id }, "paused");
			await finishRun(run.id, { state: "failed", deliveryState: "failed", error: parsed.error });
			return;
		}
		const resolved = await resolvedTargetFromRun(store, run);
		if (!resolved) {
			await finishRun(run.id, {
				state: "failed",
				deliveryState: "failed",
				error: "job run is missing target metadata",
			});
			return;
		}
		const trace = run.trace;
		input.logger.info("job.start", {
			job: row.id,
			trace,
			kind: row.kind,
			provider: resolved.adapter,
			channel: resolved.channel,
		});
		try {
			if (row.kind === "heartbeat" && resolved.thread && !(await idleEnough(store, resolved.thread, row))) {
				await finishRun(run.id, {
					state: "skipped",
					deliveryState: "none",
					output: "not idle",
				});
				return;
			}
			const adapter = adapters.get(resolved.adapter);
			const handler = adapter ? (input.starts.get(adapter)?.handler ?? input.handler) : input.handler;
			const out = await handler({
				trace,
				provider: resolved.adapter,
				eventId: trace,
				team: resolved.thread?.team || undefined,
				channel: resolved.channel,
				actor: "heypi",
				thread: resolved.threadKey,
				text: row.prompt,
				scheduled: true,
				data: { job: row.id, kind: row.kind, schedule: parsed.schedule },
			});
			if (!out) {
				await finishRun(run.id, {
					state: "skipped",
					deliveryState: "none",
					output: "no output",
				});
				return;
			}
			if (out.silent) {
				await finishRun(run.id, { state: "done", deliveryState: "none", output: out.text });
				return;
			}
			await send(resolved, out);
			await finishRun(run.id, { state: "done", deliveryState: "delivered", output: out.text });
			input.logger.info("job.done", { job: row.id, trace });
		} catch (error) {
			const msg = errorMessage(error);
			input.logger.error("job.failed", { job: row.id, trace, error: msg });
			await finishRun(run.id, { state: "failed", deliveryState: "failed", error: msg });
		}
	}

	async function finishRun(
		id: string,
		result: { state: JobRunState; output?: string; error?: string; deliveryState?: DeliveryState },
	): Promise<void> {
		await store.jobRuns.finish(id, result);
	}

	async function send(target: ResolvedTarget, out: Outbound): Promise<void> {
		const adapter = adapters.get(target.adapter);
		if (!adapter?.send) throw new Error(`adapter cannot send scheduled output: ${target.adapter}`);
		await adapter.send(target.target, out, input.starts.get(adapter));
	}

	return {
		async start(): Promise<void> {
			stopped = false;
			await installJobs({ agent: input.agent, jobs, adapters, store, logger: input.logger });
			const loop = async () => {
				if (stopped) return;
				try {
					tickPromise = tick();
					await tickPromise;
				} catch (error) {
					input.logger.error("job.tick_failed", { error: errorMessage(error) });
				} finally {
					tickPromise = undefined;
				}
				if (stopped) return;
				timer = setTimeout(loop, input.config?.pollMs ?? DEFAULT_POLL_MS);
			};
			void loop();
		},
		async stop(): Promise<void> {
			stopped = true;
			if (timer) clearTimeout(timer);
			await tickPromise?.catch(() => undefined);
			while (activeRuns.size) await Promise.allSettled([...activeRuns]);
		},
	};
}

export async function enqueueJobRuns(input: {
	agent: string;
	store: Pick<Store, "threads"> & Pick<SchedulerStore, "jobRuns">;
	job: Job;
	dueAt?: number;
	logger?: Logger;
	skipActiveHeartbeat?: boolean;
}): Promise<{ targets: number; inserted: number; skipped: number }> {
	const log = input.logger ?? logger;
	const parsed = parseJob(input.job);
	if (!parsed.ok) throw new Error(`invalid job ${parsed.field}: ${parsed.error}`);
	const dueAt = input.dueAt ?? Date.now();
	const targets = await resolveTargets({
		store: input.store,
		agent: input.agent,
		scope: parsed.scope,
		targets: parsed.targets,
	});
	let inserted = 0;
	let skipped = 0;
	for (const resolved of targets) {
		const targetKey = resolved.threadKey;
		if (input.skipActiveHeartbeat && input.job.kind === "heartbeat") {
			if (!input.store.jobRuns.hasActiveTarget) {
				throw new Error("heartbeat overlap protection requires store.jobRuns.hasActiveTarget");
			}
			if (
				await input.store.jobRuns.hasActiveTarget({
					agent: input.job.agent,
					jobId: input.job.id,
					targetKey,
					states: ["queued", "running"],
				})
			) {
				skipped++;
				log.debug("job.target_active", { job: input.job.id, targetKey });
				continue;
			}
		}
		const trace = `job:${input.job.agent}:${input.job.id}:${dueAt}:${targetKey}`;
		const run = await input.store.jobRuns.create({
			jobAgent: input.job.agent,
			jobId: input.job.id,
			threadId: resolved.thread?.id,
			trace,
			dueAt,
			targetKey,
			adapter: resolved.adapter,
			channel: resolved.channel,
			threadKey: resolved.threadKey,
			target: JSON.stringify(resolved.target),
		});
		if (run.inserted) inserted++;
		else skipped++;
	}
	return { targets: targets.length, inserted, skipped };
}

function finishResult(
	schedule: JobSchedule,
	lastAt: number,
	previous: number | null,
): { lastAt: number; nextAt: number | null } {
	return { lastAt, nextAt: nextAt(schedule, lastAt, previous) ?? null };
}

async function installJobs(input: {
	agent: string;
	jobs: JobConfig[];
	adapters: Map<string, Adapter>;
	store: SchedulerStore;
	logger: Logger;
}): Promise<void> {
	for (const config of input.jobs) {
		const kind = config.kind ?? "cron";
		const schedule = scheduleOf(config);
		validateJobRouting(config, kind, input.adapters);
		const existing = await input.store.jobs.get({ agent: input.agent, id: config.id });
		const serialized = JSON.stringify(schedule);
		const next =
			existing?.schedule === serialized && existing.nextAt ? existing.nextAt : nextAt(schedule, Date.now());
		await input.store.jobs.upsert({
			id: config.id,
			agent: input.agent,
			kind,
			schedule: serialized,
			scope: config.scope ? JSON.stringify(config.scope) : null,
			idleMs: config.idleMs ?? null,
			target: config.targets ? JSON.stringify(config.targets) : null,
			prompt: config.prompt,
			state: config.state ?? existingState(existing?.state) ?? "active",
			nextAt: next,
		});
		input.logger.debug("job.installed", { job: config.id, nextAt: next });
	}
	const ids = input.jobs.map((job) => job.id);
	const paused = await input.store.jobs.pauseMissing(input.agent, ids);
	if (paused) input.logger.warn("job.config_removed_paused", { agent: input.agent, jobs: paused });
}

function scheduleOf(job: JobConfig): JobSchedule {
	if (job.schedule && job.everyMs) throw new Error(`job cannot define both schedule and everyMs: ${job.id}`);
	if (job.schedule) return job.schedule;
	if (job.everyMs) return { everyMs: job.everyMs };
	throw new Error(`job requires schedule or everyMs: ${job.id}`);
}

type ResolvedTarget = {
	adapter: string;
	channel: string;
	threadKey: string;
	target: AdapterTarget;
	thread?: Thread;
};

async function resolveTargets(input: {
	store: Pick<Store, "threads">;
	agent: string;
	scope?: JobScope;
	targets?: JobTargets;
}): Promise<ResolvedTarget[]> {
	if (input.targets) return expandTargets(input.targets);
	if (!input.scope) return [];
	const out: ResolvedTarget[] = [];
	for (const [adapter, scope] of Object.entries(input.scope)) {
		const threads = await input.store.threads.list({
			agent: input.agent,
			providers: [adapter],
			channels: scope.channels,
			users: scope.users,
		});
		out.push(
			...threads.map((thread) => ({
				adapter,
				channel: thread.channel,
				threadKey: thread.key,
				target: { channel: thread.channel, thread: targetThread(thread) },
				thread,
			})),
		);
	}
	return out;
}

async function resolvedTargetFromRun(store: Store, run: JobRun): Promise<ResolvedTarget | undefined> {
	if (!run.adapter || !run.channel || !run.threadKey || !run.target) return undefined;
	const target = parseJson<AdapterTarget>(run.target);
	if (!target.ok || !target.value) return undefined;
	const thread = run.threadId ? await store.threads.get(run.threadId) : undefined;
	return {
		adapter: run.adapter,
		channel: run.channel,
		threadKey: run.threadKey,
		target: target.value,
		thread,
	};
}

function expandTargets(targets: JobTargets): ResolvedTarget[] {
	const out: ResolvedTarget[] = [];
	for (const [adapter, target] of Object.entries(targets)) {
		for (const channel of target.channels ?? []) {
			out.push({
				adapter,
				channel,
				threadKey: `${channel}:${channel}`,
				target: { channel },
			});
		}
		for (const user of target.users ?? []) {
			out.push({
				adapter,
				channel: user,
				threadKey: `user:${user}`,
				target: { user },
			});
		}
	}
	return out;
}

function validateJobRouting(job: JobConfig, kind: string, adapters: Map<string, Adapter>): void {
	if (job.scope && job.targets) throw new Error(`job cannot define both scope and targets: ${job.id}`);
	if (kind === "cron" && job.scope) throw new Error(`cron job cannot define scope; use targets: ${job.id}`);
	if (kind === "cron" && !hasTargets(job.targets)) throw new Error(`cron job requires targets: ${job.id}`);
	if (kind === "heartbeat" && !hasTargets(job.targets) && !hasScope(job.scope)) {
		throw new Error(`heartbeat job requires scope or targets: ${job.id}`);
	}
	if (kind === "heartbeat" && job.idleMs && hasTargets(job.targets)) {
		throw new Error(`heartbeat idleMs requires scope, not targets: ${job.id}`);
	}
	for (const name of new Set([...Object.keys(job.scope ?? {}), ...Object.keys(job.targets ?? {})])) {
		const adapter = adapters.get(name);
		if (!adapter) throw new Error(`job references unknown adapter: ${job.id} -> ${name}`);
		if (!adapter.send) throw new Error(`job references adapter without scheduled send support: ${job.id} -> ${name}`);
	}
}

function hasScope(scope: JobScope | undefined): boolean {
	return Boolean(scope && Object.keys(scope).length);
}

function hasTargets(targets: JobTargets | undefined): boolean {
	return Boolean(targets && Object.values(targets).some(hasTarget));
}

function hasTarget(target: JobTarget): boolean {
	return Boolean(target.channels?.length || target.users?.length);
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

type ParsedJob =
	| { ok: true; schedule: JobSchedule; scope?: JobScope; targets?: JobTargets }
	| { ok: false; field: "schedule" | "scope" | "target"; error: string };

function parseJob(row: Job): ParsedJob {
	const schedule = parseJson<JobSchedule>(row.schedule);
	if (!schedule.ok) return { ok: false, field: "schedule", error: schedule.error };
	const scope = parseJson<JobScope>(row.scope);
	if (!scope.ok) return { ok: false, field: "scope", error: scope.error };
	const targets = parseJson<JobTargets>(row.target);
	if (!targets.ok) return { ok: false, field: "target", error: targets.error };
	if (!schedule.value) return { ok: false, field: "schedule", error: "missing schedule" };
	return { ok: true, schedule: schedule.value, scope: scope.value, targets: targets.value };
}

function parseJson<T>(input?: string | null): { ok: true; value?: T } | { ok: false; error: string } {
	if (!input) return { ok: true };
	try {
		return { ok: true, value: JSON.parse(input) as T };
	} catch (error) {
		return { ok: false, error: errorMessage(error) };
	}
}

function existingState(state: string | undefined): "active" | "paused" | undefined {
	return state === "active" || state === "paused" ? state : undefined;
}
