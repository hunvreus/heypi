import { randomUUID } from "node:crypto";
import { and, count, desc, eq } from "drizzle-orm";
import { approval } from "../db/schema.js";
import type { Db } from "./db.js";
import { clampLimit, clampOffset } from "./paging.js";
import type { Approval } from "./types.js";

export class ApprovalRepo {
	constructor(private readonly db: Db) {}

	async create(input: {
		agent: string;
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
	}): Promise<Approval> {
		const id = randomUUID();
		await this.db.insert(approval).values({
			id,
			agent: input.agent,
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

	async get(id: string, input: { agent?: string } = {}): Promise<Approval | undefined> {
		const filters = [eq(approval.id, id)];
		if (input.agent) filters.push(eq(approval.agent, input.agent));
		const rows = await this.db
			.select()
			.from(approval)
			.where(and(...filters))
			.limit(1);
		return rows[0];
	}

	async getPending(channel: string, id: string, input: { agent?: string } = {}): Promise<Approval | undefined> {
		const filters = [eq(approval.channel, channel), eq(approval.id, id), eq(approval.state, "pending")];
		if (input.agent) filters.push(eq(approval.agent, input.agent));
		const rows = await this.db
			.select()
			.from(approval)
			.where(and(...filters))
			.limit(1);
		return rows[0];
	}

	async getByChannel(channel: string, id: string, input: { agent?: string } = {}): Promise<Approval | undefined> {
		const filters = [eq(approval.channel, channel), eq(approval.id, id)];
		if (input.agent) filters.push(eq(approval.agent, input.agent));
		const rows = await this.db
			.select()
			.from(approval)
			.where(and(...filters))
			.limit(1);
		return rows[0];
	}

	async listForThread(
		threadId: string,
		input: { agent?: string; limit?: number; offset?: number } = {},
	): Promise<Approval[]> {
		const filters = [eq(approval.threadId, threadId)];
		if (input.agent) filters.push(eq(approval.agent, input.agent));
		return await this.db
			.select()
			.from(approval)
			.where(and(...filters))
			.orderBy(desc(approval.requestedAt))
			.limit(clampLimit(input.limit, 50, 500))
			.offset(clampOffset(input.offset));
	}

	async listPending(
		input: {
			agent?: string;
			channel?: string;
			threadId?: string;
			turnId?: string;
			limit?: number;
			offset?: number;
		} = {},
	): Promise<Approval[]> {
		const filters = [eq(approval.state, "pending")];
		if (input.agent) filters.push(eq(approval.agent, input.agent));
		if (input.channel) filters.push(eq(approval.channel, input.channel));
		if (input.threadId) filters.push(eq(approval.threadId, input.threadId));
		if (input.turnId) filters.push(eq(approval.turnId, input.turnId));
		return await this.db
			.select()
			.from(approval)
			.where(and(...filters))
			.orderBy(desc(approval.requestedAt))
			.limit(clampLimit(input.limit, 5, 500))
			.offset(clampOffset(input.offset));
	}

	async countPending(input: { agent?: string; threadId?: string; turnId?: string } = {}): Promise<number> {
		const filters = [eq(approval.state, "pending")];
		if (input.agent) filters.push(eq(approval.agent, input.agent));
		if (input.threadId) filters.push(eq(approval.threadId, input.threadId));
		if (input.turnId) filters.push(eq(approval.turnId, input.turnId));
		const rows = await this.db
			.select({ value: count() })
			.from(approval)
			.where(and(...filters));
		return rows[0]?.value ?? 0;
	}

	async resolve(
		id: string,
		state: "approved" | "denied" | "expired",
		actor: string,
		input: { agent?: string } = {},
	): Promise<boolean> {
		const resolvedAt = Date.now();
		const filters = [eq(approval.id, id), eq(approval.state, "pending")];
		if (input.agent) filters.push(eq(approval.agent, input.agent));
		const rows = await this.db
			.update(approval)
			.set({ state, resolvedBy: actor, resolvedAt })
			.where(and(...filters))
			.returning({ id: approval.id });
		return rows.length === 1;
	}
}
