import { randomUUID } from "node:crypto";
import { and, desc, eq, gt, isNull, like, or, type SQL } from "drizzle-orm";
import type { ApprovalBypassScope } from "../config.js";
import { approvalBypass } from "../db/schema.js";
import type { Db } from "./db.js";

export type ApprovalBypassRow = typeof approvalBypass.$inferSelect;

export class ApprovalBypassRepo {
	constructor(private readonly db: Db) {}

	async create(input: {
		agent: string;
		scope: ApprovalBypassScope;
		channel: string;
		threadId?: string;
		actor?: string;
		createdBy: string;
		reason?: string;
		approvalId?: string;
		expiresAt: number;
	}): Promise<ApprovalBypassRow> {
		const id = randomUUID();
		const now = Date.now();
		await this.db.insert(approvalBypass).values({
			id,
			agent: input.agent,
			scope: input.scope,
			channel: input.channel,
			threadId: input.threadId,
			actor: input.actor,
			createdBy: input.createdBy,
			reason: input.reason,
			approvalId: input.approvalId,
			createdAt: now,
			expiresAt: input.expiresAt,
		});
		const row = await this.get(id);
		if (!row) throw new Error("approval bypass insert failed");
		return row;
	}

	async active(input: {
		agent: string;
		channel: string;
		threadId?: string;
		actor?: string;
		now?: number;
	}): Promise<ApprovalBypassRow | undefined> {
		const now = input.now ?? Date.now();
		const adapter = input.channel.split(":")[0] ?? input.channel;
		const filters: SQL[] = [
			eq(approvalBypass.agent, input.agent),
			gt(approvalBypass.expiresAt, now),
			isNull(approvalBypass.revokedAt),
			or(
				and(eq(approvalBypass.scope, "adapter"), likeChannelPrefix(adapter)),
				and(eq(approvalBypass.scope, "channel"), eq(approvalBypass.channel, input.channel)),
				and(eq(approvalBypass.scope, "thread"), eq(approvalBypass.threadId, input.threadId ?? "")),
				and(eq(approvalBypass.scope, "user"), eq(approvalBypass.actor, input.actor ?? "")),
			)!,
		];
		const rows = await this.db
			.select()
			.from(approvalBypass)
			.where(and(...filters))
			.orderBy(desc(approvalBypass.expiresAt))
			.limit(1);
		return rows[0];
	}

	async listActive(
		input: { agent?: string; limit?: number; offset?: number; now?: number } = {},
	): Promise<ApprovalBypassRow[]> {
		const filters: SQL[] = [gt(approvalBypass.expiresAt, input.now ?? Date.now()), isNull(approvalBypass.revokedAt)];
		if (input.agent) filters.push(eq(approvalBypass.agent, input.agent));
		return await this.db
			.select()
			.from(approvalBypass)
			.where(and(...filters))
			.orderBy(desc(approvalBypass.expiresAt))
			.limit(Math.min(Math.max(input.limit ?? 50, 1), 500))
			.offset(Math.max(input.offset ?? 0, 0));
	}

	async revoke(id: string, actor: string, input: { agent?: string } = {}): Promise<boolean> {
		const filters: SQL[] = [eq(approvalBypass.id, id), isNull(approvalBypass.revokedAt)];
		if (input.agent) filters.push(eq(approvalBypass.agent, input.agent));
		const rows = await this.db
			.update(approvalBypass)
			.set({ revokedAt: Date.now(), revokedBy: actor })
			.where(and(...filters))
			.returning({ id: approvalBypass.id });
		return rows.length === 1;
	}

	private async get(id: string): Promise<ApprovalBypassRow | undefined> {
		const rows = await this.db.select().from(approvalBypass).where(eq(approvalBypass.id, id)).limit(1);
		return rows[0];
	}
}

function likeChannelPrefix(adapter: string): SQL {
	return like(approvalBypass.channel, `${escapeLike(adapter)}:%`);
}

function escapeLike(input: string): string {
	return input.replaceAll("\\", "\\\\").replaceAll("%", "\\%").replaceAll("_", "\\_");
}
