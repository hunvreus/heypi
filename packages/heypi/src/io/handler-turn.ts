import type { ApprovalPolicy } from "../config.js";
import type { Logger } from "../core/log.js";
import { redact } from "../core/log.js";
import type { ScopedKey } from "../core/scope.js";
import type { ApprovalPrompt, ApprovalResolution, ReplyAttachment } from "../core/types.js";
import { transaction } from "../store/transaction.js";
import { saveReply } from "../store/transcript.js";
import type { Store } from "../store/types.js";
import type { Outbound } from "./handler.js";
import type { ReplyStream } from "./reply-stream.js";

export type TurnContext = {
	trace: string;
	agent: string;
	provider: string;
	channel: string;
	thread: string;
	turn: string;
	message: string;
	actor: string;
	actorGroups?: string[];
	actorBot?: boolean;
	runtimeScope?: string;
	approval?: ApprovalPolicy;
};

export async function finishSilentTurn(input: {
	store: Store;
	turn: string;
	aborted: boolean;
	stream?: ReplyStream;
	scheduled: boolean;
	base: TurnContext;
	logger: Logger;
}): Promise<Outbound | undefined> {
	await input.stream?.stop();
	// Silent replies intentionally finish the turn without adding a transcript message.
	await transaction(input.store, async (store) => {
		await store.turns.finish(input.turn, {
			state: input.aborted ? "cancelled" : "done",
		});
	});
	input.logger.debug("handler.reply", {
		...input.base,
		actor: "heypi",
		chars: 0,
		silent: true,
	});
	return input.scheduled ? { text: "", silent: true } : undefined;
}

export async function finishReplyTurn(input: {
	store: Store;
	turn: string;
	threadId: string;
	provider: string;
	kind: string;
	reply: {
		text: string;
		private?: boolean;
		silent?: boolean;
		approval?: ApprovalPrompt;
		approvalResolution?: ApprovalResolution;
		replaceOriginal?: boolean;
		attachments?: ReplyAttachment[];
	};
	aborted: boolean;
	stream?: ReplyStream;
	finalPlacement: NonNullable<Outbound["finalPlacement"]>;
	attachmentScope: ScopedKey;
	base: TurnContext;
	logger: Logger;
}): Promise<Outbound> {
	if (input.reply.approval || input.finalPlacement === "thread") await input.stream?.stop();
	else await input.stream?.finalize(redact(input.reply.text));
	await transaction(input.store, async (store) => {
		const result = await saveReply({
			store,
			threadId: input.threadId,
			provider: input.provider,
			kind: input.kind,
			reply: input.reply,
		});
		await store.turns.finish(input.turn, {
			state: input.aborted ? "cancelled" : "done",
			resultMessageId: result.id,
		});
	});
	input.logger.debug("handler.reply", {
		...input.base,
		actor: "heypi",
		chars: input.reply.text.length,
	});
	return {
		text: redact(input.reply.text),
		private: input.reply.private,
		silent: input.reply.silent,
		approval: input.reply.approval,
		approvalResolution: input.reply.approvalResolution,
		replaceOriginal: input.reply.replaceOriginal,
		attachments: input.reply.attachments,
		attachmentScope: input.attachmentScope,
		finalPlacement: input.finalPlacement,
	};
}

export async function finishSystemTurn(input: {
	store: Store;
	turn?: string;
	threadId: string;
	provider: string;
	kind: string;
	text: string;
	state: "cancelled" | "failed";
}): Promise<Outbound> {
	await transaction(input.store, async (store) => {
		const result = await store.messages.create({
			threadId: input.threadId,
			provider: input.provider,
			kind: input.kind,
			role: "system",
			actor: "heypi",
			text: input.text,
			state: input.state,
		});
		if (input.turn) await store.turns.finish(input.turn, { state: input.state, resultMessageId: result.id });
	});
	return { text: redact(input.text) };
}
