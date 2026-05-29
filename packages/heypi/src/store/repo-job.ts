import { randomUUID } from "node:crypto";
import { and, asc, desc, eq, lte, notInArray, type SQL } from "drizzle-orm";
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
		scope?: string | null;
		target?: string | null;
		prompt: string;
		state?: JobState;
		nextAt?: number | null;
		idleMs?: number | null;
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
				target: [job.agent, job.id],
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
		const row = await this.get({ agent: input.agent, id: input.id });
		if (!row) throw new Error("job upsert failed");
		return row;
	}

	async due(input: { agent: string; now: number; limit?: number }): Promise<JobRow[]> {
		return await this.db
			.select()
			.from(job)
			.where(and(eq(job.agent, input.agent), eq(job.state, "active"), lte(job.nextAt, input.now)))
			.orderBy(asc(job.nextAt))
			.limit(Math.min(Math.max(input.limit ?? 25, 1), 100));
	}

	async get(input: { agent?: string; id: string }): Promise<JobRow | undefined> {
		const rows = await this.db.select().from(job).where(jobWhere(input)).orderBy(asc(job.agent)).limit(2);
		if (rows.length > 1) throw new Error(`job id is ambiguous; pass agent: ${input.id}`);
		return rows[0];
	}

	async list(input: { agent?: string; limit?: number; offset?: number } = {}): Promise<JobRow[]> {
		return await this.db
			.select()
			.from(job)
			.where(input.agent ? eq(job.agent, input.agent) : undefined)
			.orderBy(asc(job.agent), asc(job.id))
			.limit(Math.min(Math.max(input.limit ?? 100, 1), 1000))
			.offset(Math.max(input.offset ?? 0, 0));
	}

	async setState(input: { agent?: string; id: string }, state: JobState): Promise<void> {
		const key = await this.key(input);
		if (!key) return;
		await this.db.update(job).set({ state, updatedAt: Date.now() }).where(jobWhere(key));
	}

	async runNow(input: { agent?: string; id: string }): Promise<void> {
		const key = await this.key(input);
		if (!key) return;
		await this.db.update(job).set({ nextAt: Date.now(), updatedAt: Date.now() }).where(jobWhere(key));
	}

	async finish(
		input: { agent: string; id: string },
		result: { nextAt: number | null; lastAt: number },
	): Promise<void> {
		await this.db
			.update(job)
			.set({ nextAt: result.nextAt, lastAt: result.lastAt, updatedAt: Date.now() })
			.where(jobWhere(input));
	}

	async pauseMissing(agent: string, ids: string[]): Promise<number> {
		const where = ids.length
			? and(eq(job.agent, agent), eq(job.state, "active"), notInArray(job.id, ids))
			: and(eq(job.agent, agent), eq(job.state, "active"));
		const result = await this.db.update(job).set({ state: "paused", updatedAt: Date.now() }).where(where);
		return result.rowsAffected;
	}

	private async key(input: { agent?: string; id: string }): Promise<{ agent: string; id: string } | undefined> {
		const row = await this.get(input);
		return row ? { agent: row.agent, id: row.id } : undefined;
	}
}

export class JobRunRepo {
	constructor(private readonly db: Db) {}

	async create(input: {
		jobAgent: string;
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
				jobAgent: input.jobAgent,
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

	async lastForJob(input: { agent: string; id: string }): Promise<JobRunRow | undefined> {
		const rows = await this.db
			.select()
			.from(jobRun)
			.where(and(eq(jobRun.jobAgent, input.agent), eq(jobRun.jobId, input.id)))
			.orderBy(desc(jobRun.startedAt))
			.limit(1);
		return rows[0];
	}
}

function jobWhere(input: { agent?: string; id: string }): SQL {
	return input.agent ? and(eq(job.agent, input.agent), eq(job.id, input.id))! : eq(job.id, input.id);
}
