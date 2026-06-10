import { randomUUID } from "node:crypto";
import { and, desc, eq, inArray } from "drizzle-orm";
import type { CallErrorKind, CallState } from "../core/types.js";
import { call } from "../db/schema.js";
import type { Db } from "./db.js";
import { clampLimit, clampOffset } from "./paging.js";
import type { Call } from "./types.js";

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
	}): Promise<Call> {
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
		return (await this.get(id)) as Call;
	}

	async get(id: string, input: { agent?: string } = {}): Promise<Call | undefined> {
		const filters = [eq(call.id, id)];
		if (input.agent) filters.push(eq(call.agent, input.agent));
		const rows = await this.db
			.select()
			.from(call)
			.where(and(...filters))
			.limit(1);
		return rows[0];
	}

	async getByChannel(channel: string, id: string, input: { agent?: string } = {}): Promise<Call | undefined> {
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
	): Promise<Call[]> {
		const filters = [eq(call.threadId, threadId)];
		if (input.agent) filters.push(eq(call.agent, input.agent));
		if (input.states?.length) filters.push(inArray(call.state, input.states));
		return await this.db
			.select()
			.from(call)
			.where(and(...filters))
			.orderBy(desc(call.updatedAt))
			.limit(clampLimit(input.limit, 5, 25));
	}

	async listRecent(
		input: { agent?: string; states?: CallState[]; limit?: number; offset?: number } = {},
	): Promise<Call[]> {
		const filters = [];
		if (input.agent) filters.push(eq(call.agent, input.agent));
		if (input.states?.length) filters.push(inArray(call.state, input.states));
		const query = this.db.select().from(call);
		const withFilter = filters.length ? query.where(and(...filters)) : query;
		return await withFilter
			.orderBy(desc(call.updatedAt))
			.limit(clampLimit(input.limit, 100, 500))
			.offset(clampOffset(input.offset));
	}

	async failRunning(input: { agent: string; error: string }): Promise<number> {
		const now = Date.now();
		const rows = await this.db
			.update(call)
			.set({
				state: "failed",
				code: 1,
				out: "",
				err: input.error,
				ms: 0,
				queueWaitMs: 0,
				updatedAt: now,
			})
			.where(and(eq(call.agent, input.agent), eq(call.state, "running")))
			.returning({ id: call.id });
		return rows.length;
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
		input: {
			state: CallState;
			code: number;
			out: string;
			err: string;
			errKind?: CallErrorKind;
			ms: number;
			queueWaitMs: number;
		},
	): Promise<void> {
		await this.db
			.update(call)
			.set({
				state: input.state,
				code: input.code,
				out: input.out,
				err: input.err,
				errKind: input.errKind,
				ms: input.ms,
				queueWaitMs: input.queueWaitMs,
				updatedAt: Date.now(),
			})
			.where(eq(call.id, id));
	}
}
