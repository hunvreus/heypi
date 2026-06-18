import { randomUUID } from "node:crypto";
import { and, desc, eq, type SQL, sql } from "drizzle-orm";
import { redact } from "../core/log.js";
import { event } from "../db/schema.js";
import type { Db } from "./db.js";
import { clampLimit } from "./paging.js";
import type { Event, EventType } from "./types.js";

export class EventRepo {
	constructor(private readonly db: Db) {}

	async append(input: {
		agent: string;
		trace: string;
		type: EventType;
		data?: unknown;
		threadId?: string;
		turnId?: string;
		callId?: string;
		approvalId?: string;
		jobRunId?: string;
		createdAt?: number;
	}): Promise<Event> {
		const seq = await this.nextSeq(input.trace);
		const id = randomUUID();
		await this.db.insert(event).values({
			id,
			agent: input.agent,
			trace: input.trace,
			threadId: input.threadId,
			turnId: input.turnId,
			callId: input.callId,
			approvalId: input.approvalId,
			jobRunId: input.jobRunId,
			seq,
			type: input.type,
			data: JSON.stringify(input.data ?? {}, redactEventValue),
			createdAt: input.createdAt ?? Date.now(),
		});
		const row = await this.get(id);
		if (!row) throw new Error("event insert failed");
		return row;
	}

	async list(input: {
		agent?: string;
		trace?: string;
		threadId?: string;
		turnId?: string;
		callId?: string;
		approvalId?: string;
		jobRunId?: string;
		limit?: number;
	}): Promise<Event[]> {
		const filters: SQL[] = [];
		if (input.agent) filters.push(eq(event.agent, input.agent));
		if (input.trace) filters.push(eq(event.trace, input.trace));
		if (input.threadId) filters.push(eq(event.threadId, input.threadId));
		if (input.turnId) filters.push(eq(event.turnId, input.turnId));
		if (input.callId) filters.push(eq(event.callId, input.callId));
		if (input.approvalId) filters.push(eq(event.approvalId, input.approvalId));
		if (input.jobRunId) filters.push(eq(event.jobRunId, input.jobRunId));
		return await this.db
			.select()
			.from(event)
			.where(filters.length ? and(...filters) : undefined)
			.orderBy(desc(event.createdAt), desc(event.seq))
			.limit(clampLimit(input.limit, 100, 1000));
	}

	private async get(id: string): Promise<Event | undefined> {
		const rows = await this.db.select().from(event).where(eq(event.id, id)).limit(1);
		return rows[0];
	}

	private async nextSeq(trace: string): Promise<number> {
		const rows = await this.db
			.select({ value: sql<number>`coalesce(max(${event.seq}), -1) + 1` })
			.from(event)
			.where(eq(event.trace, trace));
		return rows[0]?.value ?? 0;
	}
}

function redactEventValue(_key: string, value: unknown): unknown {
	return typeof value === "string" ? redact(value) : value;
}
