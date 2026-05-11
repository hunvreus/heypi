import { randomUUID } from "node:crypto";
import type { ModelConfig } from "../config.js";
import { ActiveRuns, cancelReply, isAbortError } from "../core/active.js";
import type { CallRunner } from "../core/calls.js";
import { helpReply, renderThreadStatus } from "../core/format.js";
import { normalizeText, parseIntent } from "../core/intent.js";
import { type Logger, logError, logger, message, userError } from "../core/log.js";
import type { ApprovalPrompt, ReplyAttachment } from "../core/types.js";
import type { Agent } from "../runtime/agent.js";
import { continueTool, saveReply } from "../store/transcript.js";
import type { Store } from "../store/types.js";
import { type Attachment, type AttachmentStore, attachmentPrompt } from "./attachments.js";

export type Inbound = {
	trace?: string;
	provider: string;
	eventId?: string;
	channel: string;
	actor: string;
	thread: string;
	text: string;
	model?: ModelConfig;
	attachments?: Attachment[];
	data?: unknown;
};

export type Outbound = {
	text: string;
	private?: boolean;
	approval?: ApprovalPrompt;
	attachments?: ReplyAttachment[];
};

export type Handler = (input: Inbound) => Promise<Outbound | undefined>;

export type AdapterStart = {
	handler: Handler;
	logger: Logger;
	attachments?: AttachmentStore;
};

/** Messaging platform boundary. Adapters translate provider events into `Inbound` messages. */
export interface Adapter {
	start(input: AdapterStart): Promise<void>;
	stop?(): Promise<void>;
}

/** Creates the provider-neutral handler shared by Slack, Telegram, and future adapters. */
export function createHandler(input: {
	agentId?: string;
	store: Store;
	callRunner: CallRunner;
	agent: Agent;
	active?: ActiveRuns;
	logger?: Logger;
}): Handler {
	const agentId = input.agentId ?? "default";
	const log = input.logger ?? logger;
	const active = input.active ?? new ActiveRuns();
	return async (msg) => {
		const trace = msg.trace ?? randomUUID();
		const rawText = normalizeText(msg.text);
		const text = attachmentPrompt(rawText, msg.attachments);
		log.debug("handler.receive", {
			trace,
			agent: agentId,
			provider: msg.provider,
			channel: msg.channel,
			thread: msg.thread,
			actor: msg.actor,
			event: msg.eventId,
		});
		const intent = parseIntent({ text: rawText || text, channel: msg.channel, actor: msg.actor });
		if (intent.kind === "cancel") return cancelReply(active.cancel(intent.id));
		const messageText = intent.kind === "ask" ? text : rawText;

		const thread = await input.store.threads.getOrCreate({
			agent: agentId,
			provider: msg.provider,
			channel: msg.channel,
			actor: msg.actor,
			key: msg.thread,
		});
		const lockKey = `thread:${agentId}:${msg.provider}:${msg.channel}:${thread.id}`;
		const lockOwner = `${trace}:${randomUUID()}`;
		if (intent.kind === "thread_status") {
			const [turns, calls, approvals, currentLock] = await Promise.all([
				input.store.turns.listForThread(thread.id, { limit: 5 }),
				input.store.calls.listForThread(thread.id, {
					states: ["running", "pending_approval", "blocked", "failed", "cancelled"],
					limit: 5,
				}),
				input.store.approvals.listPending({ threadId: thread.id, limit: 5 }),
				input.store.locks?.get(lockKey),
			]);
			return renderThreadStatus({
				active: turns.find((row) => row.state === "running"),
				turns,
				calls,
				approvals,
				lock: currentLock,
			});
		}
		const shouldLock = needsLock(intent.kind) && input.store.locks !== undefined;
		const lock = shouldLock ? await input.store.locks?.acquire({ key: lockKey, owner: lockOwner }) : undefined;
		if (shouldLock && !lock) {
			log.debug("handler.locked", {
				trace,
				agent: agentId,
				provider: msg.provider,
				channel: msg.channel,
				thread: msg.thread,
				event: msg.eventId,
			});
			return { text: "A turn is already running for this thread. Try again when it finishes.", private: true };
		}
		let turn: Awaited<ReturnType<Store["turns"]["create"]>> | undefined;
		let run: ReturnType<ActiveRuns["start"]> | undefined;
		let base:
			| {
					trace: string;
					agent: string;
					provider: string;
					channel: string;
					thread: string;
					turn: string;
					message: string;
					actor: string;
			  }
			| undefined;
		try {
			const inbound = await input.store.messages.createOnce({
				threadId: thread.id,
				provider: msg.provider,
				providerEventId: msg.eventId,
				role: "user",
				actor: msg.actor,
				text: messageText,
				data: JSON.stringify(data(msg.data, trace, msg.attachments, msg.model)),
				state: "done",
			});
			if (!inbound.inserted) {
				log.debug("handler.duplicate", {
					trace,
					agent: agentId,
					provider: msg.provider,
					channel: msg.channel,
					thread: msg.thread,
					event: msg.eventId,
				});
				return undefined;
			}
			turn = await input.store.turns.create({
				threadId: thread.id,
				inputMessageId: inbound.row.id,
				agent: agentId,
				provider: msg.provider,
				channel: msg.channel,
				actor: msg.actor,
				trace,
			});
			base = {
				trace,
				agent: agentId,
				provider: msg.provider,
				channel: msg.channel,
				thread: thread.id,
				turn: turn.id,
				message: inbound.row.id,
				actor: msg.actor,
			};

			log.debug("handler.intent", { ...base, kind: intent.kind });
			run = active.start([trace, turn.id]);
			let reply =
				intent.kind === "help"
					? helpReply()
					: intent.kind === "ask"
						? await input.agent.ask({
								threadId: thread.id,
								inputMessageId: inbound.row.id,
								turnId: turn.id,
								channel: intent.channel,
								actor: intent.actor,
								trace,
								text: messageText,
								model: msg.model,
								signal: run.signal,
							})
						: await input.callRunner.handle(intent, base, run.signal);
			if (run.signal.aborted) reply = { text: "cancelled" };
			const targetThreadId = reply.continuation?.threadId;
			if (reply.continuation) {
				reply = await continueTool({
					store: input.store,
					agent: input.agent,
					provider: msg.provider,
					channel: msg.channel,
					actor: msg.actor,
					trace,
					turn: turn.id,
					continuation: reply.continuation,
				});
			}
			const result = await saveReply({
				store: input.store,
				threadId: targetThreadId ?? thread.id,
				provider: msg.provider,
				reply,
			});
			await input.store.turns.finish(turn.id, {
				state: run.signal.aborted ? "cancelled" : "done",
				resultMessageId: result.id,
			});
			log.debug("handler.reply", {
				...base,
				actor: "heypi",
				chars: reply.text.length,
			});
			return { text: reply.text, private: reply.private, approval: reply.approval, attachments: reply.attachments };
		} catch (error) {
			if ((run?.signal.aborted || isAbortError(error)) && turn) {
				const reply = "cancelled";
				const result = await input.store.messages.create({
					threadId: thread.id,
					provider: msg.provider,
					role: "system",
					actor: "heypi",
					text: reply,
					state: "cancelled",
				});
				await input.store.turns.finish(turn.id, { state: "cancelled", resultMessageId: result.id });
				return { text: reply };
			}
			logError(log, "handler", {
				...(base ?? {
					trace,
					agent: agentId,
					provider: msg.provider,
					channel: msg.channel,
					thread: thread.id,
					actor: msg.actor,
				}),
				error: message(error),
			});
			const reply = userError("handler");
			const result = await input.store.messages.create({
				threadId: thread.id,
				provider: msg.provider,
				role: "system",
				actor: "heypi",
				text: reply,
				state: "failed",
			});
			if (turn) await input.store.turns.finish(turn.id, { state: "failed", resultMessageId: result.id });
			return { text: reply };
		} finally {
			run?.stop();
			if (lock) await input.store.locks?.release({ key: lockKey, owner: lockOwner });
		}
	};
}

function needsLock(kind: string): boolean {
	return kind !== "help" && kind !== "status";
}

function data(input: unknown, trace: string, attachments?: Attachment[], model?: ModelConfig): Record<string, unknown> {
	const files = attachments?.length ? { attachments } : {};
	const override = model ? { model } : {};
	if (input && typeof input === "object" && !Array.isArray(input)) {
		return { ...(input as Record<string, unknown>), ...files, ...override, trace };
	}
	if (input === undefined) return { ...files, ...override, trace };
	return { ...files, ...override, trace, data: input };
}
