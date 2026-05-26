import { randomUUID } from "node:crypto";
import { and, desc, eq } from "drizzle-orm";
import { approval } from "../db/schema.js";
import type { Db } from "./db.js";

export type ApprovalRow = typeof approval.$inferSelect;

export class ApprovalRepo {
	constructor(private readonly db: Db) {}

	async create(input: {
		callId: string;
		channel: string;
		threadId?: string;
		turnId?: string;
		requestMessageId?: string;
		requestedBy?: string;
		expiresAt?: number;
		command: string;
		runtime: string;
		reason: string;
		details?: string;
	}): Promise<ApprovalRow> {
		const id = randomUUID();
		await this.db.insert(approval).values({
			id,
			callId: input.callId,
			channel: input.channel,
			threadId: input.threadId,
			turnId: input.turnId,
			requestMessageId: input.requestMessageId,
			command: input.command,
			runtime: input.runtime,
			reason: input.reason,
			details: input.details,
			state: "pending",
			requestedBy: input.requestedBy,
			expiresAt: input.expiresAt,
			requestedAt: Date.now(),
		});
		const row = await this.get(id);
		if (!row) throw new Error("approval insert failed");
		return row;
	}

	async get(id: string): Promise<ApprovalRow | undefined> {
		const rows = await this.db.select().from(approval).where(eq(approval.id, id)).limit(1);
		return rows[0];
	}

	async getPending(channel: string, id: string): Promise<ApprovalRow | undefined> {
		const rows = await this.db
			.select()
			.from(approval)
			.where(and(eq(approval.channel, channel), eq(approval.id, id), eq(approval.state, "pending")))
			.limit(1);
		return rows[0];
	}

	async getByChannel(channel: string, id: string): Promise<ApprovalRow | undefined> {
		const rows = await this.db
			.select()
			.from(approval)
			.where(and(eq(approval.channel, channel), eq(approval.id, id)))
			.limit(1);
		return rows[0];
	}

	async listPending(
		input: { threadId?: string; turnId?: string; limit?: number; offset?: number } = {},
	): Promise<ApprovalRow[]> {
		const filters = [eq(approval.state, "pending")];
		if (input.threadId) filters.push(eq(approval.threadId, input.threadId));
		if (input.turnId) filters.push(eq(approval.turnId, input.turnId));
		return await this.db
			.select()
			.from(approval)
			.where(and(...filters))
			.orderBy(desc(approval.requestedAt))
			.limit(Math.min(Math.max(input.limit ?? 5, 1), 500))
			.offset(Math.max(input.offset ?? 0, 0));
	}

	async resolve(id: string, state: "approved" | "denied", actor: string): Promise<boolean> {
		const resolvedAt = Date.now();
		await this.db
			.update(approval)
			.set({ state, resolvedBy: actor, resolvedAt })
			.where(and(eq(approval.id, id), eq(approval.state, "pending")));
		const row = await this.get(id);
		return row?.state === state && row.resolvedBy === actor && row.resolvedAt === resolvedAt;
	}
}
