import { randomUUID } from "node:crypto";
import { and, desc, eq, inArray } from "drizzle-orm";
import type { CallState } from "../core/types.js";
import { call } from "../db/schema.js";
import type { Db } from "./db.js";

export type CallRow = typeof call.$inferSelect;

export class CallRepo {
	constructor(private readonly db: Db) {}

	async create(input: {
		agent: string;
		turnId?: string;
		threadId?: string;
		messageId?: string;
		channel: string;
		actor?: string;
		tool: string;
		toolCallId?: string;
		command?: string;
		args?: string;
		runtime?: string;
		state: CallState;
		policyReason?: string;
	}): Promise<CallRow> {
		const id = randomUUID();
		const now = Date.now();
		await this.db.insert(call).values({
			id,
			agent: input.agent,
			turnId: input.turnId,
			threadId: input.threadId,
			messageId: input.messageId,
			channel: input.channel,
			actor: input.actor,
			tool: input.tool,
			toolCallId: input.toolCallId,
			command: input.command,
			args: input.args,
			runtime: input.runtime,
			state: input.state,
			policyReason: input.policyReason,
			createdAt: now,
			updatedAt: now,
		});
		return (await this.get(id)) as CallRow;
	}

	async get(id: string, input: { agent?: string } = {}): Promise<CallRow | undefined> {
		const filters = [eq(call.id, id)];
		if (input.agent) filters.push(eq(call.agent, input.agent));
		const rows = await this.db
			.select()
			.from(call)
			.where(and(...filters))
			.limit(1);
		return rows[0];
	}

	async getByChannel(channel: string, id: string, input: { agent?: string } = {}): Promise<CallRow | undefined> {
		const filters = [eq(call.channel, channel), eq(call.id, id)];
		if (input.agent) filters.push(eq(call.agent, input.agent));
		const rows = await this.db
			.select()
			.from(call)
			.where(and(...filters))
			.limit(1);
		return rows[0];
	}

	async listForThread(
		threadId: string,
		input: { agent?: string; states?: CallState[]; limit?: number } = {},
	): Promise<CallRow[]> {
		const filters = [eq(call.threadId, threadId)];
		if (input.agent) filters.push(eq(call.agent, input.agent));
		if (input.states?.length) filters.push(inArray(call.state, input.states));
		return await this.db
			.select()
			.from(call)
			.where(and(...filters))
			.orderBy(desc(call.updatedAt))
			.limit(Math.min(Math.max(input.limit ?? 5, 1), 25));
	}

	async listRecent(
		input: { agent?: string; states?: CallState[]; limit?: number; offset?: number } = {},
	): Promise<CallRow[]> {
		const filters = [];
		if (input.agent) filters.push(eq(call.agent, input.agent));
		if (input.states?.length) filters.push(inArray(call.state, input.states));
		const query = this.db.select().from(call);
		const withFilter = filters.length ? query.where(and(...filters)) : query;
		return await withFilter
			.orderBy(desc(call.updatedAt))
			.limit(Math.min(Math.max(input.limit ?? 100, 1), 500))
			.offset(Math.max(input.offset ?? 0, 0));
	}

	async setState(id: string, state: CallState, input: { agent?: string } = {}): Promise<void> {
		const filters = [eq(call.id, id)];
		if (input.agent) filters.push(eq(call.agent, input.agent));
		await this.db
			.update(call)
			.set({ state, updatedAt: Date.now() })
			.where(and(...filters));
	}

	async finish(
		id: string,
		input: { state: CallState; code: number; out: string; err: string; ms: number; queueWaitMs: number },
	): Promise<void> {
		await this.db
			.update(call)
			.set({
				state: input.state,
				code: input.code,
				out: input.out,
				err: input.err,
				ms: input.ms,
				queueWaitMs: input.queueWaitMs,
				updatedAt: Date.now(),
			})
			.where(eq(call.id, id));
	}
}
