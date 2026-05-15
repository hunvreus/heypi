import { randomUUID } from "node:crypto";
import { and, asc, desc, eq, lte } from "drizzle-orm";
import { job, jobRun } from "../db/schema.js";
import type { Db } from "./db.js";
import type { DeliveryState, JobRunState, JobState } from "./types.js";

export type JobRow = typeof job.$inferSelect;
export type JobRunRow = typeof jobRun.$inferSelect;

export class JobRepo {
	constructor(private readonly db: Db) {}

	async upsert(input: {
		id: string;
		agent: string;
		kind: string;
		schedule: string;
		scope?: string;
		target?: string;
		prompt: string;
		state?: JobState;
		nextAt?: number;
		idleMs?: number;
	}): Promise<JobRow> {
		const now = Date.now();
		const values = {
			id: input.id,
			agent: input.agent,
			kind: input.kind,
			schedule: input.schedule,
			scope: input.scope,
			target: input.target,
			prompt: input.prompt,
			state: input.state ?? "active",
			nextAt: input.nextAt,
			idleMs: input.idleMs,
			createdAt: now,
			updatedAt: now,
		};
		await this.db
			.insert(job)
			.values(values)
			.onConflictDoUpdate({
				target: job.id,
				set: {
					agent: values.agent,
					kind: values.kind,
					schedule: values.schedule,
					scope: values.scope,
					target: values.target,
					prompt: values.prompt,
					state: values.state,
					nextAt: values.nextAt,
					idleMs: values.idleMs,
					updatedAt: now,
				},
			});
		const row = await this.get(input.id);
		if (!row) throw new Error("job upsert failed");
		return row;
	}

	async due(now: number, limit = 25): Promise<JobRow[]> {
		return await this.db
			.select()
			.from(job)
			.where(and(eq(job.state, "active"), lte(job.nextAt, now)))
			.orderBy(asc(job.nextAt))
			.limit(Math.min(Math.max(limit, 1), 100));
	}

	async get(id: string): Promise<JobRow | undefined> {
		const rows = await this.db.select().from(job).where(eq(job.id, id)).limit(1);
		return rows[0];
	}

	async list(input: { limit?: number } = {}): Promise<JobRow[]> {
		return await this.db
			.select()
			.from(job)
			.orderBy(asc(job.id))
			.limit(Math.min(Math.max(input.limit ?? 100, 1), 1000));
	}

	async setState(id: string, state: JobState): Promise<void> {
		await this.db.update(job).set({ state, updatedAt: Date.now() }).where(eq(job.id, id));
	}

	async runNow(id: string): Promise<void> {
		await this.db.update(job).set({ nextAt: Date.now(), updatedAt: Date.now() }).where(eq(job.id, id));
	}

	async finish(id: string, input: { nextAt?: number; lastAt: number }): Promise<void> {
		await this.db
			.update(job)
			.set({ nextAt: input.nextAt, lastAt: input.lastAt, updatedAt: Date.now() })
			.where(eq(job.id, id));
	}
}

export class JobRunRepo {
	constructor(private readonly db: Db) {}

	async create(input: {
		jobId: string;
		threadId?: string;
		trace: string;
	}): Promise<{ row: JobRunRow; inserted: boolean }> {
		const id = randomUUID();
		const now = Date.now();
		await this.db
			.insert(jobRun)
			.values({
				id,
				jobId: input.jobId,
				threadId: input.threadId,
				trace: input.trace,
				state: "running",
				deliveryState: "pending",
				startedAt: now,
			})
			.onConflictDoNothing();
		const rows = await this.db.select().from(jobRun).where(eq(jobRun.trace, input.trace)).limit(1);
		const row = rows[0];
		if (!row) throw new Error("job run insert failed");
		return { row, inserted: row.id === id };
	}

	async finish(
		id: string,
		input: { state: JobRunState; output?: string; error?: string; deliveryState?: DeliveryState },
	): Promise<void> {
		await this.db
			.update(jobRun)
			.set({
				state: input.state,
				output: input.output,
				error: input.error,
				deliveryState: input.deliveryState ?? "none",
				endedAt: Date.now(),
			})
			.where(eq(jobRun.id, id));
	}

	async lastForJob(jobId: string): Promise<JobRunRow | undefined> {
		const rows = await this.db
			.select()
			.from(jobRun)
			.where(eq(jobRun.jobId, jobId))
			.orderBy(desc(jobRun.startedAt))
			.limit(1);
		return rows[0];
	}
}
