import { randomUUID } from "node:crypto";
import type { ApprovalConfig, ModelConfig } from "../config.js";
import { ActiveRuns, cancelReply, isAbortError } from "../core/active.js";
import type { CallRunner } from "../core/calls.js";
import { helpReply, renderApprovals, renderThreadStatus } from "../core/format.js";
import { normalizeText, parseIntent } from "../core/intent.js";
import { type Logger, logError, logger, message, redact, userError } from "../core/log.js";
import type { ApprovalPrompt, Intent, ReplyAttachment } from "../core/types.js";
import type { Agent } from "../runtime/agent.js";
import { continueTool, saveReply } from "../store/transcript.js";
import type { Store } from "../store/types.js";
import { type Attachment, type AttachmentStore, attachmentPrompt } from "./attachments.js";
import type { ReplyStream } from "./reply-stream.js";

export type Inbound = {
	trace?: string;
	provider: string;
	eventId?: string;
	team?: string;
	channel: string;
	channelName?: string;
	actor: string;
	actorName?: string;
	thread: string;
	threadName?: string;
	text: string;
	model?: ModelConfig;
	attachments?: Attachment[];
	data?: unknown;
	scheduled?: boolean;
	stream?: ReplyStream;
	ack?: (out: Outbound) => Promise<void>;
	replace?: (out: Outbound) => Promise<void>;
};

export type Outbound = {
	text: string;
	private?: boolean;
	silent?: boolean;
	approval?: ApprovalPrompt;
	attachments?: ReplyAttachment[];
};

export type Handler = (input: Inbound) => Promise<Outbound | undefined>;

export type StatusResult = {
	ok: boolean;
	threadId: string;
	runId: string;
	status: string;
	text?: string;
	approval?: ApprovalPrompt;
	error?: string;
	createdAt?: number;
	updatedAt?: number;
};

export type Status = (input: {
	provider: string;
	team?: string;
	threadId: string;
	runId: string;
}) => Promise<StatusResult | undefined>;

export type AdapterStart = {
	handler: Handler;
	status?: Status;
	logger: Logger;
	attachments?: AttachmentStore;
};

/** Messaging platform boundary. Adapters translate provider events into `Inbound` messages. */
export interface Adapter {
	name?: string;
	start(input: AdapterStart): Promise<void>;
	send?(target: AdapterTarget, out: Outbound, input?: AdapterStart): Promise<void>;
	stop?(): Promise<void>;
}

export type AdapterTarget = {
	adapter?: string;
	channel?: string;
	user?: string;
	thread?: string;
	mode?: "channel" | "thread" | "dm";
};

/** Creates the provider-neutral handler shared by Slack, Telegram, and future adapters. */
export function createHandler(input: {
	agentId?: string;
	store: Store;
	callRunner: CallRunner;
	agent: Agent;
	approval?: ApprovalConfig;
	active?: ActiveRuns;
	lockMs?: number;
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
		const scheduled = msg.scheduled === true;
		const stream = intent.kind === "ask" ? msg.stream : undefined;

		const thread = await input.store.threads.getOrCreate({
			agent: agentId,
			provider: msg.provider,
			team: msg.team,
			channel: msg.channel,
			actor: msg.actor,
			key: msg.thread,
		});
		const lockKey = `thread:${thread.id}`;
		const lockOwner = `${trace}:${randomUUID()}`;
		if (intent.kind === "approvals") {
			if (!canListApprovals(input.approval, msg.actor)) {
				return { text: "You are not allowed to view pending approvals.", private: true };
			}
			const all = await input.store.approvals.listPending({ limit: 25 });
			const rows = all.filter((row) => approvalVisible(row, input.approval, msg, thread.id));
			return renderApprovals(rows);
		}
		if (intent.kind === "thread_status") {
			const [turns, calls, approvals, currentLock] = await Promise.all([
				input.store.turns.listForThread(thread.id, { limit: 5 }),
				input.store.calls.listForThread(thread.id, {
					states: ["running", "pending_approval"],
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
		const shouldLock = requiresThreadLock(intent.kind) && input.store.locks !== undefined;
		const lock = shouldLock
			? await input.store.locks?.acquire({ key: lockKey, owner: lockOwner, ttlMs: input.lockMs })
			: undefined;
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
			const created = await transaction(input.store, async (store) => {
				const inbound = await store.messages.createOnce({
					threadId: thread.id,
					provider: msg.provider,
					providerEventId: msg.eventId,
					role: "user",
					actor: msg.actor,
					text: messageText,
					data: JSON.stringify(data(msg.data, trace, msg.attachments, msg.model)),
					state: "done",
				});
				if (!inbound.inserted) return { inbound };
				const turn = await store.turns.create({
					threadId: thread.id,
					inputMessageId: inbound.row.id,
					agent: agentId,
					provider: msg.provider,
					channel: msg.channel,
					actor: msg.actor,
					trace,
				});
				return { inbound, turn };
			});
			const inbound = created.inbound;
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
			turn = created.turn;
			if (!turn) throw new Error("turn insert failed");
			base = {
				trace,
				agent: agentId,
				provider: msg.provider,
				channel: scopeKey(msg),
				thread: thread.id,
				turn: turn.id,
				message: inbound.row.id,
				actor: msg.actor,
			};

			log.debug("handler.intent", { ...base, kind: intent.kind });
			const currentTurn = turn;
			run = active.start([trace, currentTurn.id]);
			const currentRun = run;
			let reply =
				intent.kind === "help"
					? helpReply()
					: intent.kind === "ask"
						? await input.agent.ask({
								threadId: thread.id,
								sessionId: thread.sessionId,
								sessionPath: thread.sessionPath,
								inputMessageId: inbound.row.id,
								turnId: currentTurn.id,
								provider: msg.provider,
								channel: scopeKey(msg),
								channelName: msg.channelName,
								thread: msg.thread,
								threadName: msg.threadName,
								actor: intent.actor,
								actorName: msg.actorName,
								trace,
								text: messageText,
								model: msg.model,
								attachments: msg.attachments,
								signal: currentRun.signal,
								stream,
							})
						: await input.callRunner.handle(
								scopedIntent(intent as CallIntent, msg),
								base,
								currentRun.signal,
								intent.kind === "approve" ? msg.ack : undefined,
								intent.kind === "approve" ? msg.replace : undefined,
							);
			if (currentRun.signal.aborted) reply = { text: "cancelled" };
			const targetThreadId = reply.continuation?.threadId;
			if (reply.continuation) {
				reply = await continueTool({
					store: input.store,
					agent: input.agent,
					channel: scopeKey(msg),
					provider: msg.provider,
					actor: msg.actor,
					trace,
					turn: currentTurn.id,
					continuation: reply.continuation,
					stream,
				});
			}
			if (reply.silent) {
				await stream?.stop();
				// Silent replies intentionally finish the turn without adding a transcript message.
				await transaction(input.store, async (store) => {
					await store.turns.finish(currentTurn.id, {
						state: currentRun.signal.aborted ? "cancelled" : "done",
					});
				});
				log.debug("handler.reply", {
					...base,
					actor: "heypi",
					chars: 0,
					silent: true,
				});
				return scheduled ? { text: "", silent: true } : undefined;
			}
			if (reply.approval) await stream?.stop();
			else await stream?.finalize(redact(reply.text));
			await transaction(input.store, async (store) => {
				const result = await saveReply({
					store,
					threadId: targetThreadId ?? thread.id,
					provider: msg.provider,
					reply,
				});
				await store.turns.finish(currentTurn.id, {
					state: currentRun.signal.aborted ? "cancelled" : "done",
					resultMessageId: result.id,
				});
			});
			log.debug("handler.reply", {
				...base,
				actor: "heypi",
				chars: reply.text.length,
			});
			return {
				text: redact(reply.text),
				private: reply.private,
				silent: reply.silent,
				approval: reply.approval,
				attachments: reply.attachments,
			};
		} catch (error) {
			if ((run?.signal.aborted || isAbortError(error)) && turn) {
				await stream?.stop();
				const currentTurn = turn;
				const reply = "cancelled";
				await transaction(input.store, async (store) => {
					const result = await store.messages.create({
						threadId: thread.id,
						provider: msg.provider,
						role: "system",
						actor: "heypi",
						text: reply,
						state: "cancelled",
					});
					await store.turns.finish(currentTurn.id, { state: "cancelled", resultMessageId: result.id });
				});
				return { text: redact(reply) };
			}
			await stream?.stop();
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
			await transaction(input.store, async (store) => {
				const result = await store.messages.create({
					threadId: thread.id,
					provider: msg.provider,
					role: "system",
					actor: "heypi",
					text: reply,
					state: "failed",
				});
				if (turn) await store.turns.finish(turn.id, { state: "failed", resultMessageId: result.id });
			});
			return { text: redact(reply) };
		} finally {
			run?.stop();
			if (lock) await input.store.locks?.release({ key: lockKey, owner: lockOwner });
		}
	};
}

export function createStatus(input: { agentId?: string; store: Store }): Status {
	const agentId = input.agentId ?? "default";
	return async ({ provider, team, threadId, runId }) => {
		const thread = await input.store.threads.getByKey(agentId, provider, team, threadId);
		if (!thread) return undefined;
		const turn = await input.store.turns.getByTrace(thread.id, runId);
		if (!turn) return undefined;
		const result = turn.resultMessageId ? await input.store.messages.get(turn.resultMessageId) : undefined;
		const approval = (await input.store.approvals.listPending({ threadId: thread.id, turnId: turn.id, limit: 1 }))[0];
		return {
			ok: turn.state !== "failed",
			threadId,
			runId,
			status: approval ? "pending_approval" : turn.state,
			text: result ? redact(result.text) : undefined,
			approval: approval
				? {
						id: approval.id,
						callId: approval.callId,
						command: redact(approval.command),
						runtime: approval.runtime,
						reason: approval.reason,
						allowed: [],
					}
				: undefined,
			error: turn.state === "failed" && result ? redact(result.text) : undefined,
			createdAt: turn.createdAt,
			updatedAt: turn.updatedAt,
		};
	};
}

async function transaction<T>(store: Store, fn: (store: Store) => Promise<T>): Promise<T> {
	return store.transaction ? store.transaction(fn) : fn(store);
}

function requiresThreadLock(kind: string): boolean {
	return kind !== "help" && kind !== "status" && kind !== "approvals";
}

type CallIntent = Exclude<Intent, { kind: "ask" | "help" | "cancel" | "approvals" | "thread_status" }>;

function scopedIntent(intent: CallIntent, msg: Inbound): CallIntent {
	const channel = scopeKey(msg);
	if (intent.kind === "bash") return { ...intent, channel };
	if (intent.kind === "approve") return { ...intent, channel };
	if (intent.kind === "deny") return { ...intent, channel };
	if (intent.kind === "status") return { ...intent, channel };
	return intent;
}

function scopeKey(msg: Pick<Inbound, "provider" | "team" | "channel">): string {
	return `${msg.provider}:${msg.team ?? ""}:${msg.channel}`;
}

function canListApprovals(config: ApprovalConfig | undefined, actor: string): boolean {
	const approvers = config?.approvers ?? [];
	return approvers.length === 0 || approvers.includes(actor);
}

function approvalVisible(
	row: { channel: string; threadId: string | null },
	config: ApprovalConfig | undefined,
	msg: Pick<Inbound, "provider" | "team">,
	threadId: string,
): boolean {
	const approvers = config?.approvers ?? [];
	if (!approvers.length) return row.threadId === threadId;
	return row.channel.startsWith(`${msg.provider}:${msg.team ?? ""}:`);
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
