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
	claim(scheduleId: string, scheduledFor: string, firedAt: string, manual?: boolean): Promise<ScheduleRun | undefined>;
	skip(scheduleId: string, scheduledFor: string, firedAt: string, error: string): Promise<ScheduleRun>;
	update(id: string, patch: Partial<Omit<ScheduleRun, "id" | "scheduleId">>): Promise<ScheduleRun>;
	hasOccurrence(scheduleId: string, scheduledFor: string): boolean;
	active(scheduleId: string): boolean;
	runs(scheduleId?: string): ScheduleRun[];
};

export function createScheduleStore(path: string): ScheduleStore {
	let state: ScheduleState = { version: 1, definitions: {}, runs: [] };
	let writes = Promise.resolve();

	async function persist(): Promise<void> {
		const task = writes.then(async () => {
			await mkdir(dirname(path), { recursive: true });
			const temporary = `${path}.${process.pid}.tmp`;
			await writeFile(temporary, `${JSON.stringify(state, null, 2)}\n`, "utf8");
			await rename(temporary, path);
		});
		writes = task.catch(() => undefined);
		await task;
	}

	function prune(): boolean {
		const terminalCounts = new Map<string, number>();
		const kept = new Set<string>();
		for (let index = state.runs.length - 1; index >= 0; index--) {
			const run = state.runs[index];
			if (!run) continue;
			if (!TERMINAL.has(run.status)) {
				kept.add(run.id);
				continue;
			}
			const count = terminalCounts.get(run.scheduleId) ?? 0;
			if (count < MAX_TERMINAL_RUNS_PER_SCHEDULE) kept.add(run.id);
			terminalCounts.set(run.scheduleId, count + 1);
		}
		if (kept.size === state.runs.length) return false;
		state.runs = state.runs.filter((run) => kept.has(run.id));
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
			try {
				state = JSON.parse(await readFile(path, "utf8")) as ScheduleState;
			} catch (error) {
				if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
			}
			let changed = false;
			const now = new Date().toISOString();
			for (const run of state.runs) {
				if (!ACTIVE.has(run.status)) continue;
				run.status = "failed";
				run.error = "interrupted by restart";
				run.finishedAt = now;
				changed = true;
			}
			if (prune()) changed = true;
			if (changed) await persist();
		},

		async reconcile(definitions) {
			const previous = new Set(Object.keys(state.definitions));
			const next = Object.fromEntries(
				definitions.map((schedule) => [schedule.id, { path: schedule.path, hash: schedule.hash }]),
			);
			const orphans = Object.keys(state.definitions).filter((id) => !(id in next));
			const added = Object.keys(next).filter((id) => !previous.has(id));
			const changed = Object.keys(next).filter(
				(id) => previous.has(id) && state.definitions[id]?.hash !== next[id]?.hash,
			);
			state.definitions = next;
			await persist();
			return { added, changed, orphans };
		},

		async claim(scheduleId, scheduledFor, firedAt, manual) {
			if (state.runs.some((run) => run.scheduleId === scheduleId && run.scheduledFor === scheduledFor))
				return undefined;
			if (state.runs.some((run) => run.scheduleId === scheduleId && ACTIVE.has(run.status))) return undefined;
			const run = createRun(scheduleId, scheduledFor, firedAt, "claimed", manual);
			state.runs.push(run);
			prune();
			await persist();
			return { ...run };
		},

		async skip(scheduleId, scheduledFor, firedAt, error) {
			const run = createRun(scheduleId, scheduledFor, firedAt, "skipped");
			run.error = error;
			run.finishedAt = firedAt;
			state.runs.push(run);
			prune();
			await persist();
			return { ...run };
		},

		async update(id, patch) {
			const run = state.runs.find((candidate) => candidate.id === id);
			if (!run) throw new Error(`Unknown schedule run: ${id}`);
			if (patch.status && !TRANSITIONS[run.status].has(patch.status)) {
				throw new Error(`Invalid schedule run transition: ${run.status} -> ${patch.status}`);
			}
			if (TERMINAL.has(run.status) && patch.status === undefined) {
				throw new Error(`Cannot update terminal schedule run: ${run.id}`);
			}
			Object.assign(run, patch);
			const result = { ...run };
			if (TERMINAL.has(run.status)) prune();
			await persist();
			return result;
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
