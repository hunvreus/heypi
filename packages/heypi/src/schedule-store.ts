import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import type { LoadedSchedule } from "./schedule.js";

export type ScheduleRunStatus = "claimed" | "dispatched" | "running" | "completed" | "failed" | "canceled" | "skipped";

export type ScheduleRun = {
	id: string;
	scheduleId: string;
	scheduledFor: string;
	firedAt: string;
	status: ScheduleRunStatus;
	manual?: boolean;
	jobId?: string;
	sessionId?: string;
	output?: string;
	error?: string;
	finishedAt?: string;
};

export type ScheduleClaim = { action: "claimed" | "existing"; run: ScheduleRun } | { action: "active" };

type ScheduleState = {
	version: 1;
	definitions: Record<string, { path: string; hash: string }>;
	runs: ScheduleRun[];
};

const ACTIVE = new Set<ScheduleRunStatus>(["claimed", "dispatched", "running"]);
const TERMINAL = new Set<ScheduleRunStatus>(["completed", "failed", "canceled", "skipped"]);
const MAX_TERMINAL_RUNS_PER_SCHEDULE = 100;
const TRANSITIONS: Record<ScheduleRunStatus, ReadonlySet<ScheduleRunStatus>> = {
	claimed: new Set(["running", "dispatched", "completed", "failed", "canceled"]),
	dispatched: new Set(["completed", "failed", "canceled"]),
	running: new Set(["completed", "failed", "canceled"]),
	completed: new Set(["completed"]),
	failed: new Set(["failed"]),
	canceled: new Set(["canceled"]),
	skipped: new Set(["skipped"]),
};

export type ScheduleStore = {
	load(): Promise<void>;
	reconcile(definitions: LoadedSchedule[]): Promise<{ added: string[]; changed: string[]; orphans: string[] }>;
	claim(scheduleId: string, scheduledFor: string, firedAt: string, manual?: boolean): Promise<ScheduleClaim>;
	skip(scheduleId: string, scheduledFor: string, firedAt: string, error: string): Promise<ScheduleRun>;
	update(id: string, patch: Partial<Omit<ScheduleRun, "id" | "scheduleId">>): Promise<ScheduleRun>;
	hasOccurrence(scheduleId: string, scheduledFor: string): boolean;
	active(scheduleId: string): boolean;
	runs(scheduleId?: string): ScheduleRun[];
};

export function createScheduleStore(path: string): ScheduleStore {
	let state: ScheduleState = { version: 1, definitions: {}, runs: [] };
	let updates = Promise.resolve();

	async function persist(next: ScheduleState): Promise<void> {
		await mkdir(dirname(path), { recursive: true });
		const temporary = `${path}.${process.pid}.tmp`;
		await writeFile(temporary, `${JSON.stringify(next, null, 2)}\n`, "utf8");
		await rename(temporary, path);
	}

	function copyState(): ScheduleState {
		return {
			version: 1,
			definitions: Object.fromEntries(
				Object.entries(state.definitions).map(([id, definition]) => [id, { ...definition }]),
			),
			runs: state.runs.map((run) => ({ ...run })),
		};
	}

	function mutate<T>(change: (next: ScheduleState) => T): Promise<T> {
		const task = updates.then(async () => {
			const next = copyState();
			const result = change(next);
			await persist(next);
			state = next;
			return result;
		});
		updates = task.then(
			() => undefined,
			() => undefined,
		);
		return task;
	}

	function prune(next: ScheduleState): boolean {
		const terminalCounts = new Map<string, number>();
		const kept = new Set<string>();
		for (let index = next.runs.length - 1; index >= 0; index--) {
			const run = next.runs[index];
			if (!run) continue;
			if (!TERMINAL.has(run.status)) {
				kept.add(run.id);
				continue;
			}
			const count = terminalCounts.get(run.scheduleId) ?? 0;
			if (count < MAX_TERMINAL_RUNS_PER_SCHEDULE) kept.add(run.id);
			terminalCounts.set(run.scheduleId, count + 1);
		}
		if (kept.size === next.runs.length) return false;
		next.runs = next.runs.filter((run) => kept.has(run.id));
		return true;
	}

	function createRun(
		scheduleId: string,
		scheduledFor: string,
		firedAt: string,
		status: ScheduleRunStatus,
		manual?: boolean,
	): ScheduleRun {
		return { id: randomUUID(), scheduleId, scheduledFor, firedAt, status, manual: manual || undefined };
	}

	return {
		async load() {
			let next = state;
			try {
				next = JSON.parse(await readFile(path, "utf8")) as ScheduleState;
			} catch (error) {
				if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
			}
			let changed = false;
			const now = new Date().toISOString();
			for (const run of next.runs) {
				if (!ACTIVE.has(run.status)) continue;
				run.status = "failed";
				run.error = "interrupted by restart";
				run.finishedAt = now;
				changed = true;
			}
			if (prune(next)) changed = true;
			if (changed) await persist(next);
			state = next;
		},

		async reconcile(definitions) {
			return mutate((next) => {
				const previous = new Set(Object.keys(next.definitions));
				const definitionsById = Object.fromEntries(
					definitions.map((schedule) => [schedule.id, { path: schedule.path, hash: schedule.hash }]),
				);
				const orphans = Object.keys(next.definitions).filter((id) => !(id in definitionsById));
				const added = Object.keys(definitionsById).filter((id) => !previous.has(id));
				const changed = Object.keys(definitionsById).filter(
					(id) => previous.has(id) && next.definitions[id]?.hash !== definitionsById[id]?.hash,
				);
				next.definitions = definitionsById;
				return { added, changed, orphans };
			});
		},

		async claim(scheduleId, scheduledFor, firedAt, manual) {
			return mutate((next) => {
				const existing = next.runs.find(
					(run) => run.scheduleId === scheduleId && run.scheduledFor === scheduledFor,
				);
				if (existing) return { action: "existing" as const, run: { ...existing } };
				if (next.runs.some((run) => run.scheduleId === scheduleId && ACTIVE.has(run.status))) {
					return { action: "active" as const };
				}
				const run = createRun(scheduleId, scheduledFor, firedAt, "claimed", manual);
				next.runs.push(run);
				prune(next);
				return { action: "claimed" as const, run: { ...run } };
			});
		},

		async skip(scheduleId, scheduledFor, firedAt, error) {
			return mutate((next) => {
				const run = createRun(scheduleId, scheduledFor, firedAt, "skipped");
				run.error = error;
				run.finishedAt = firedAt;
				next.runs.push(run);
				prune(next);
				return { ...run };
			});
		},

		async update(id, patch) {
			return mutate((next) => {
				const run = next.runs.find((candidate) => candidate.id === id);
				if (!run) throw new Error(`Unknown schedule run: ${id}`);
				if (patch.status && !TRANSITIONS[run.status].has(patch.status)) {
					throw new Error(`Invalid schedule run transition: ${run.status} -> ${patch.status}`);
				}
				if (TERMINAL.has(run.status) && patch.status === undefined) {
					throw new Error(`Cannot update terminal schedule run: ${run.id}`);
				}
				Object.assign(run, patch);
				const result = { ...run };
				if (TERMINAL.has(run.status)) prune(next);
				return result;
			});
		},

		hasOccurrence(scheduleId, scheduledFor) {
			return state.runs.some((run) => run.scheduleId === scheduleId && run.scheduledFor === scheduledFor);
		},

		active(scheduleId) {
			return state.runs.some((run) => run.scheduleId === scheduleId && ACTIVE.has(run.status));
		},

		runs(scheduleId) {
			return state.runs.filter((run) => !scheduleId || run.scheduleId === scheduleId).map((run) => ({ ...run }));
		},
	};
}
