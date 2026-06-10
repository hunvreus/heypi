import { randomUUID } from "node:crypto";
import { and, desc, eq, inArray } from "drizzle-orm";
import type { TurnState } from "../core/types.js";
import { turn } from "../db/schema.js";
import type { Db } from "./db.js";
import { clampLimit, clampOffset } from "./paging.js";
import type { Turn } from "./types.js";

export class TurnRepo {
	constructor(private readonly db: Db) {}

	async create(input: {
		threadId: string;
		inputMessageId: string;
		agent: string;
		provider: string;
		kind?: string;
		channel: string;
		actor?: string;
		trace?: string;
		state?: TurnState;
	}): Promise<Turn> {
		const id = randomUUID();
		const now = Date.now();
		await this.db.insert(turn).values({
			id,
			threadId: input.threadId,
			inputMessageId: input.inputMessageId,
			agent: input.agent,
			provider: input.provider,
			kind: input.kind ?? input.provider,
			channel: input.channel,
			actor: input.actor,
			trace: input.trace,
			state: input.state ?? "running",
			createdAt: now,
			updatedAt: now,
		});
		const row = await this.get(id);
		if (!row) throw new Error("turn insert failed");
		return row;
	}

	async finish(id: string, input: { state: TurnState; resultMessageId?: string }): Promise<void> {
		await this.db
			.update(turn)
			.set({ state: input.state, resultMessageId: input.resultMessageId, updatedAt: Date.now() })
			.where(eq(turn.id, id));
	}

	async listForThread(threadId: string, input: { limit?: number } = {}): Promise<Turn[]> {
		return await this.db
			.select()
			.from(turn)
			.where(eq(turn.threadId, threadId))
			.orderBy(desc(turn.updatedAt))
			.limit(clampLimit(input.limit, 5, 25));
	}

	async listRunning(input: { agent?: string; limit?: number } = {}): Promise<Turn[]> {
		const filters = [eq(turn.state, "running")];
		if (input.agent) filters.push(eq(turn.agent, input.agent));
		return await this.db
			.select()
			.from(turn)
			.where(and(...filters))
			.orderBy(desc(turn.updatedAt))
			.limit(clampLimit(input.limit, 100, 500));
	}

	async listRecent(
		input: { agent?: string; states?: TurnState[]; limit?: number; offset?: number } = {},
	): Promise<Turn[]> {
		const filters = [];
		if (input.agent) filters.push(eq(turn.agent, input.agent));
		if (input.states?.length) filters.push(inArray(turn.state, input.states));
		const query = this.db.select().from(turn);
		const withFilter = filters.length ? query.where(and(...filters)) : query;
		return await withFilter
			.orderBy(desc(turn.updatedAt))
			.limit(clampLimit(input.limit, 100, 500))
			.offset(clampOffset(input.offset));
	}

	async getByTrace(threadId: string, trace: string): Promise<Turn | undefined> {
		const rows = await this.db
			.select()
			.from(turn)
			.where(and(eq(turn.threadId, threadId), eq(turn.trace, trace)))
			.limit(1);
		return rows[0];
	}

	private async get(id: string): Promise<Turn | undefined> {
		const rows = await this.db.select().from(turn).where(eq(turn.id, id)).limit(1);
		return rows[0];
	}
}
