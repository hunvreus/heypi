import { randomUUID } from "node:crypto";
import { desc, eq } from "drizzle-orm";
import type { TurnState } from "../core/types.js";
import { turn } from "../db/schema.js";
import type { Db } from "./db.js";

export type TurnRow = typeof turn.$inferSelect;

export class TurnRepo {
	constructor(private readonly db: Db) {}

	async create(input: {
		threadId: string;
		inputMessageId: string;
		agent: string;
		provider: string;
		channel: string;
		actor?: string;
		trace?: string;
		state?: TurnState;
	}): Promise<TurnRow> {
		const id = randomUUID();
		const now = Date.now();
		await this.db.insert(turn).values({
			id,
			threadId: input.threadId,
			inputMessageId: input.inputMessageId,
			agent: input.agent,
			provider: input.provider,
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

	async listForThread(threadId: string, input: { limit?: number } = {}): Promise<TurnRow[]> {
		return await this.db
			.select()
			.from(turn)
			.where(eq(turn.threadId, threadId))
			.orderBy(desc(turn.updatedAt))
			.limit(Math.min(Math.max(input.limit ?? 5, 1), 25));
	}

	private async get(id: string): Promise<TurnRow | undefined> {
		const rows = await this.db.select().from(turn).where(eq(turn.id, id)).limit(1);
		return rows[0];
	}
}
