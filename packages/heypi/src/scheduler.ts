import { Cron } from "croner";
import type { LoadedSchedule, ScheduleDispatch } from "./schedule.js";
import type { ScheduleRun, ScheduleStore } from "./schedule-store.js";
import type { Logger } from "./types.js";

const DEFAULT_MISFIRE_GRACE_MS = 5 * 60 * 1000;
const DEFAULT_SHUTDOWN_GRACE_MS = 5_000;

export type ScheduleInfo = {
	id: string;
	cron: string;
	timezone: string;
	nextRun?: string;
	active: boolean;
	lastRun?: ScheduleRun;
};

export type Scheduler = {
	start(): Promise<void>;
	stop(): Promise<void>;
	list(): ScheduleInfo[];
	run(id: string): Promise<ScheduleRun>;
	runs(id?: string): ScheduleRun[];
};

export type SchedulerOptions = {
	definitions: LoadedSchedule[];
	store: ScheduleStore;
	logger: Logger;
	dispatch(input: ScheduleDispatch, run: ScheduleRun): Promise<{ jobId: string }>;
	executePrompt(
		schedule: LoadedSchedule,
		run: ScheduleRun,
		signal: AbortSignal,
	): Promise<{
		output?: string;
		sessionId?: string;
	}>;
	misfireGraceMs?: number;
	shutdownGraceMs?: number;
};

export function createScheduler(options: SchedulerOptions): Scheduler {
	const definitions = new Map(options.definitions.map((schedule) => [schedule.id, schedule]));
	const jobs = new Map<string, Cron>();
	const controllers = new Map<string, AbortController>();
	const tasks = new Set<Promise<ScheduleRun>>();
	let started = false;

	async function execute(schedule: LoadedSchedule, run: ScheduleRun): Promise<ScheduleRun> {
		const controller = new AbortController();
		controllers.set(run.id, controller);
		try {
			if (schedule.definition.prompt !== undefined) {
				await options.store.update(run.id, { status: "running" });
				const result = await options.executePrompt(schedule, run, controller.signal);
				if (controller.signal.aborted) throw new Error("schedule canceled");
				return await options.store.update(run.id, {
					status: "completed",
					output: result.output,
					sessionId: result.sessionId,
					finishedAt: new Date().toISOString(),
				});
			}

			let dispatchCalled = false;
			await schedule.definition.run({
				scheduleId: schedule.id,
				runId: run.id,
				scheduledFor: run.scheduledFor,
				firedAt: run.firedAt,
				signal: controller.signal,
				async dispatch(input) {
					if (dispatchCalled) throw new Error("A schedule handler may dispatch only once.");
					if (controller.signal.aborted) throw new Error("schedule canceled");
					dispatchCalled = true;
					const accepted = await options.dispatch(input, run);
					await options.store.update(run.id, { status: "dispatched", jobId: accepted.jobId });
					return accepted;
				},
			});
			if (controller.signal.aborted) throw new Error("schedule canceled");
			if (dispatchCalled) {
				const current = options.store.runs(schedule.id).find((candidate) => candidate.id === run.id);
				if (!current) throw new Error(`Dispatched schedule run disappeared: ${run.id}`);
				return current;
			}
			return await options.store.update(run.id, {
				status: "completed",
				finishedAt: new Date().toISOString(),
			});
		} catch (error) {
			const canceled = controller.signal.aborted;
			const message = error instanceof Error ? error.message : String(error);
			const current = options.store.runs(schedule.id).find((candidate) => candidate.id === run.id);
			if (current?.status === "dispatched" || current?.finishedAt) {
				options.logger.warn("schedule.handler.failed_after_dispatch", {
					schedule: schedule.id,
					run: run.id,
					message,
				});
				return current;
			}
			const failed = await options.store.update(run.id, {
				status: canceled ? "canceled" : "failed",
				error: message,
				finishedAt: new Date().toISOString(),
			});
			options.logger.error("schedule.run.failed", { schedule: schedule.id, run: run.id, message });
			return failed;
		} finally {
			controllers.delete(run.id);
		}
	}

	function track(task: Promise<ScheduleRun>): void {
		tasks.add(task);
		void task.then(
			() => tasks.delete(task),
			(error) => {
				tasks.delete(task);
				options.logger.error("schedule.task.failed", {
					message: error instanceof Error ? error.message : String(error),
				});
			},
		);
	}

	async function drainTasks(): Promise<void> {
		if (tasks.size === 0) return;
		const graceMs = options.shutdownGraceMs ?? DEFAULT_SHUTDOWN_GRACE_MS;
		let timer: ReturnType<typeof setTimeout> | undefined;
		const timedOut = await Promise.race([
			Promise.allSettled([...tasks]).then(() => false),
			new Promise<true>((resolve) => {
				timer = setTimeout(() => resolve(true), graceMs);
			}),
		]);
		if (timer) clearTimeout(timer);
		if (timedOut) options.logger.warn("scheduler.stop.timeout", { tasks: tasks.size, graceMs });
	}

	async function claimAndStart(schedule: LoadedSchedule, scheduledFor: Date, manual = false): Promise<ScheduleRun> {
		const scheduled = scheduledFor.toISOString();
		const firedAt = new Date().toISOString();
		if (options.store.hasOccurrence(schedule.id, scheduled)) {
			const existing = options.store.runs(schedule.id).find((run) => run.scheduledFor === scheduled);
			if (!existing) throw new Error(`Schedule occurrence was claimed without a run: ${schedule.id}`);
			return existing;
		}
		if (options.store.active(schedule.id)) {
			const skipped = await options.store.skip(schedule.id, scheduled, firedAt, "previous run still active");
			options.logger.warn("schedule.run.skipped", { schedule: schedule.id, run: skipped.id, reason: skipped.error });
			return skipped;
		}
		const run = await options.store.claim(schedule.id, scheduled, firedAt, manual);
		if (!run) throw new Error(`Schedule occurrence could not be claimed: ${schedule.id}`);
		options.logger.info("schedule.run.claimed", { schedule: schedule.id, run: run.id, scheduledFor: scheduled });
		const task = execute(schedule, run);
		track(task);
		return run;
	}

	function cronFor(schedule: LoadedSchedule, paused: boolean): Cron {
		return new Cron(
			schedule.definition.cron,
			{
				timezone: schedule.definition.timezone,
				mode: "5-part",
				paused,
				protect: true,
				catch: (error) => {
					options.logger.error("schedule.timer.failed", {
						schedule: schedule.id,
						message: error instanceof Error ? error.message : String(error),
					});
				},
			},
			(job) => claimAndStart(schedule, job.currentRun() ?? new Date()).then(() => undefined),
		);
	}

	async function recover(schedule: LoadedSchedule): Promise<void> {
		const parser = cronFor(schedule, true);
		try {
			const previous = parser.previousRuns(1)[0];
			if (!previous) return;
			const scheduled = previous.toISOString();
			if (options.store.hasOccurrence(schedule.id, scheduled)) return;
			const age = Date.now() - previous.getTime();
			if (age <= (options.misfireGraceMs ?? DEFAULT_MISFIRE_GRACE_MS)) {
				await claimAndStart(schedule, previous);
				return;
			}
			await options.store.skip(
				schedule.id,
				scheduled,
				new Date().toISOString(),
				"missed occurrence exceeded grace window",
			);
		} finally {
			parser.stop();
		}
	}

	return {
		async start() {
			if (started) return;
			try {
				await options.store.load();
				const { added, changed, orphans } = await options.store.reconcile(options.definitions);
				for (const id of orphans) options.logger.warn("schedule.orphaned", { schedule: id });
				for (const schedule of options.definitions) {
					if (!added.includes(schedule.id) && !changed.includes(schedule.id)) await recover(schedule);
					jobs.set(schedule.id, cronFor(schedule, false));
				}
				started = true;
			} catch (error) {
				for (const job of jobs.values()) job.stop();
				jobs.clear();
				for (const controller of controllers.values()) controller.abort("scheduler failed to start");
				await drainTasks();
				throw error;
			}
			if (options.definitions.length)
				options.logger.info("scheduler.start", { schedules: options.definitions.length });
		},

		async stop() {
			if (!started) return;
			started = false;
			for (const job of jobs.values()) job.stop();
			jobs.clear();
			for (const controller of controllers.values()) controller.abort("application stopped");
			await drainTasks();
		},

		list() {
			return options.definitions.map((schedule) => {
				const runs = options.store.runs(schedule.id);
				const next = jobs.get(schedule.id)?.nextRun();
				return {
					id: schedule.id,
					cron: schedule.definition.cron,
					timezone: schedule.definition.timezone,
					nextRun: next?.toISOString(),
					active: options.store.active(schedule.id),
					lastRun: runs.at(-1),
				};
			});
		},

		async run(id) {
			if (!started) throw new Error("Scheduler is not started.");
			const schedule = definitions.get(id);
			if (!schedule) throw new Error(`Unknown schedule: ${id}`);
			const scheduledFor = new Date();
			while (options.store.hasOccurrence(id, scheduledFor.toISOString())) {
				scheduledFor.setTime(scheduledFor.getTime() + 1);
			}
			return claimAndStart(schedule, scheduledFor, true);
		},

		runs(id) {
			return options.store.runs(id);
		},
	};
}
