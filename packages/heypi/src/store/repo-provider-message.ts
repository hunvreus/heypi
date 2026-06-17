import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { providerMessage } from "../db/schema.js";
import type { Db } from "./db.js";
import type { ProviderMessage } from "./types.js";

export class ProviderMessageRepo {
	constructor(private readonly db: Db) {}

	async upsert(input: {
		agent: string;
		provider: string;
		team?: string;
		channel: string;
		providerMessageId: string;
		threadId: string;
		actor?: string;
	}): Promise<ProviderMessage> {
		const found = await this.get(input);
		const now = Date.now();
		if (found) {
			await this.db
				.update(providerMessage)
				.set({ threadId: input.threadId, actor: input.actor, updatedAt: now })
				.where(eq(providerMessage.id, found.id));
			const updated = await this.get(input);
			if (!updated) throw new Error("provider message update failed");
			return updated;
		}

		const id = randomUUID();
		await this.db
			.insert(providerMessage)
			.values({
				id,
				agent: input.agent,
				provider: input.provider,
				team: input.team ?? "",
				channel: input.channel,
				providerMessageId: input.providerMessageId,
				threadId: input.threadId,
				actor: input.actor,
				createdAt: now,
				updatedAt: now,
			})
			.onConflictDoNothing();
		const row = await this.get(input);
		if (!row) throw new Error("provider message insert failed");
		return row;
	}

	async get(input: {
		agent: string;
		provider: string;
		team?: string;
		channel: string;
		providerMessageId: string;
	}): Promise<ProviderMessage | undefined> {
		const rows = await this.db
			.select()
			.from(providerMessage)
			.where(
				and(
					eq(providerMessage.agent, input.agent),
					eq(providerMessage.provider, input.provider),
					eq(providerMessage.team, input.team ?? ""),
					eq(providerMessage.channel, input.channel),
					eq(providerMessage.providerMessageId, input.providerMessageId),
				),
			)
			.limit(1);
		return rows[0];
	}
}
