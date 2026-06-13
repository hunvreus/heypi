import { randomUUID } from "node:crypto";
import { and, asc, count, desc, eq, inArray, lte, notInArray, type SQL, sql } from "drizzle-orm";
import { job, jobRun } from "../db/schema.js";
import type { JobState } from "../job.js";
import type { Db } from "./db.js";
import { clampLimit, clampOffset } from "./paging.js";
import type { DeliveryState, Job, JobRun, JobRunState } from "./types.js";

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
	}): Promise<Job> {
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

	async due(input: { agent: string; now: number; limit?: number }): Promise<Job[]> {
		return await this.db
			.select()
			.from(job)
			.where(and(eq(job.agent, input.agent), eq(job.state, "active"), lte(job.nextAt, input.now)))
			.orderBy(asc(job.nextAt))
			.limit(clampLimit(input.limit, 25, 100));
	}

	async get(input: { agent?: string; id: string }): Promise<Job | undefined> {
		const rows = await this.db.select().from(job).where(jobWhere(input)).orderBy(asc(job.agent)).limit(2);
		if (rows.length > 1) throw new Error(`job id is ambiguous; pass agent: ${input.id}`);
		return rows[0];
	}

	async list(input: { agent?: string; limit?: number; offset?: number } = {}): Promise<Job[]> {
		return await this.db
			.select()
			.from(job)
			.where(input.agent ? eq(job.agent, input.agent) : undefined)
			.orderBy(asc(job.agent), asc(job.id))
			.limit(clampLimit(input.limit, 100, 1000))
			.offset(clampOffset(input.offset));
	}

	async count(input: { agent?: string; state?: JobState; dueAt?: number } = {}): Promise<number> {
		const filters: SQL[] = [];
		if (input.agent) filters.push(eq(job.agent, input.agent));
		if (input.state) filters.push(eq(job.state, input.state));
		if (input.dueAt !== undefined) filters.push(lte(job.nextAt, input.dueAt));
		const rows = await this.db
			.select({ value: count() })
			.from(job)
			.where(filters.length ? and(...filters) : undefined);
		return rows[0]?.value ?? 0;
	}

	async setState(input: { agent?: string; id: string }, state: JobState): Promise<void> {
		const key = await this.key(input);
		if (!key) return;
		await this.db.update(job).set({ state, updatedAt: Date.now() }).where(jobWhere(key));
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
		dueAt?: number;
		targetKey?: string;
		adapter?: string;
		channel?: string;
		threadKey?: string;
		target?: string | null;
		availableAt?: number;
	}): Promise<{ row: JobRun; inserted: boolean }> {
		const id = randomUUID();
		const now = Date.now();
		const dueAt = input.dueAt ?? now;
		const targetKey = input.targetKey ?? "";
		await this.db
			.insert(jobRun)
			.values({
				id,
				jobAgent: input.jobAgent,
				jobId: input.jobId,
				threadId: input.threadId,
				trace: input.trace,
				dueAt,
				targetKey,
				adapter: input.adapter,
				channel: input.channel,
				threadKey: input.threadKey,
				target: input.target,
				availableAt: input.availableAt ?? now,
				attempts: 0,
				state: "queued",
				deliveryState: "pending",
				createdAt: now,
				startedAt: 0,
			})
			.onConflictDoNothing();
		const rows = await this.db.select().from(jobRun).where(eq(jobRun.trace, input.trace)).limit(1);
		const row = rows[0];
		if (!row) throw new Error("job run insert failed");
		return { row, inserted: row.id === id };
	}

	async claim(input: { agent: string; owner: string; now: number; limit?: number }): Promise<JobRun[]> {
		const rows = await this.db
			.select()
			.from(jobRun)
			.where(and(eq(jobRun.jobAgent, input.agent), eq(jobRun.state, "queued"), lte(jobRun.availableAt, input.now)))
			.orderBy(asc(jobRun.availableAt), asc(jobRun.createdAt))
			.limit(clampLimit(input.limit, 1, 100));
		if (!rows.length) return [];
		const ids = rows.map((row) => row.id);
		const claimed = await this.db
			.update(jobRun)
			.set({
				state: "running",
				claimedBy: input.owner,
				startedAt: input.now,
				attempts: sql`${jobRun.attempts} + 1`,
			})
			.where(and(eq(jobRun.state, "queued"), inArray(jobRun.id, ids)))
			.returning();
		return claimed;
	}

	async hasActiveTarget(input: {
		agent: string;
		jobId: string;
		targetKey: string;
		states?: JobRunState[];
	}): Promise<boolean> {
		const states = input.states ?? ["queued", "running"];
		if (!states.length) return false;
		const rows = await this.db
			.select({ id: jobRun.id })
			.from(jobRun)
			.where(
				and(
					eq(jobRun.jobAgent, input.agent),
					eq(jobRun.jobId, input.jobId),
					eq(jobRun.targetKey, input.targetKey),
					inArray(jobRun.state, states),
				),
			)
			.limit(1);
		return rows.length > 0;
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
				claimedBy: null,
				endedAt: Date.now(),
			})
			.where(eq(jobRun.id, id));
	}

	async requeue(input: { id: string; availableAt?: number; error?: string }): Promise<void> {
		await this.db
			.update(jobRun)
			.set({
				state: "queued",
				availableAt: input.availableAt ?? Date.now(),
				claimedBy: null,
				error: input.error,
				deliveryState: "pending",
				startedAt: 0,
				endedAt: null,
			})
			.where(eq(jobRun.id, input.id));
	}

	async lastForJob(input: { agent: string; id: string }): Promise<JobRun | undefined> {
		const rows = await this.db
			.select()
			.from(jobRun)
			.where(and(eq(jobRun.jobAgent, input.agent), eq(jobRun.jobId, input.id)))
			.orderBy(desc(jobRun.createdAt), desc(jobRun.startedAt))
			.limit(1);
		return rows[0];
	}

	async cancelQueuedForJob(input: { agent: string; id: string; reason?: string }): Promise<number> {
		const rows = await this.db
			.update(jobRun)
			.set({
				state: "cancelled",
				error: input.reason,
				deliveryState: "none",
				endedAt: Date.now(),
			})
			.where(and(eq(jobRun.jobAgent, input.agent), eq(jobRun.jobId, input.id), eq(jobRun.state, "queued")))
			.returning({ id: jobRun.id });
		return rows.length;
	}

	async requeueRunning(input: { agent: string; error?: string }): Promise<number> {
		const rows = await this.db
			.update(jobRun)
			.set({
				state: "queued",
				error: input.error,
				deliveryState: "pending",
				claimedBy: null,
				availableAt: Date.now(),
				startedAt: 0,
				endedAt: null,
			})
			.where(and(eq(jobRun.jobAgent, input.agent), eq(jobRun.state, "running")))
			.returning({ id: jobRun.id });
		return rows.length;
	}

	async failRunning(input: { agent: string; error: string }): Promise<number> {
		return await this.requeueRunning(input);
	}
}

function jobWhere(input: { agent?: string; id: string }): SQL {
	return input.agent ? and(eq(job.agent, input.agent), eq(job.id, input.id))! : eq(job.id, input.id);
}
