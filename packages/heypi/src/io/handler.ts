import { randomUUID } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { ApprovalPolicy, ModelConfig, PermissionsConfig, Scope, TaskConfig } from "../config.js";
import { ActiveRuns, cancelReply, isAbortError } from "../core/active.js";
import type { CallRunner } from "../core/calls.js";
import { helpReply, renderApprovalBypasses, renderApprovals, renderThreadStatus } from "../core/format.js";
import { normalizeText, parseIntent } from "../core/intent.js";
import { type Logger, logError, logger, message, redact, userError } from "../core/log.js";
import type { Memory, NormalizedMemoryConfig } from "../core/memory.js";
import { type AppMessages, DEFAULT_APP_MESSAGES } from "../core/messages.js";
import type { ScopedKey } from "../core/scope.js";
import { isSecretReply, type Secrets } from "../core/secrets.js";
import type { NormalizedSkillsConfig } from "../core/skills.js";
import type { ApprovalPrompt, ApprovalResolution, ReplyAttachment } from "../core/types.js";
import type { Agent } from "../runtime/agent.js";
import type { Runtime, RuntimeEventHandler } from "../runtime/types.js";
import { transaction } from "../store/transaction.js";
import { continueTool } from "../store/transcript.js";
import type { Store } from "../store/types.js";
import { type Attachment, type AttachmentStore, attachmentPrompt } from "./attachments.js";
import {
	actorMention,
	attributedMessage,
	bypassVisible,
	type CallIntent,
	canCancelRun,
	cancelText,
	canListApprovals,
	normalizeTask,
	requiresThreadLock,
	scopedIntent,
} from "./handler-control.js";
import { resolveTurnScope, channelKey as scopedChannelKey } from "./handler-scope.js";
import { completeSecretReply } from "./handler-secret.js";
import { finishReplyTurn, finishSilentTurn, finishSystemTurn, type TurnContext } from "./handler-turn.js";
import type { ReplyStream } from "./reply-stream.js";

export type Inbound = {
	trace?: string;
	provider: string;
	kind?: string;
	eventId?: string;
	providerMessageId?: string;
	team?: string;
	channel: string;
	channelName?: string;
	actor: string;
	actorName?: string;
	actorGroups?: string[];
	actorBot?: boolean;
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
	runtimeProgress?: RuntimeProgress;
};

export type RuntimeProgress = {
	update(text: string): Promise<void> | void;
};

export type Outbound = {
	text: string;
	private?: boolean;
	silent?: boolean;
	approval?: ApprovalPrompt;
	approvalResolution?: ApprovalResolution;
	replaceOriginal?: boolean;
	attachments?: ReplyAttachment[];
	attachmentScope?: ScopedKey;
	finalPlacement?: "progress" | "thread";
};

export type Handler = ((input: Inbound) => Promise<Outbound | undefined>) & {
	attachmentScope?: (input: Pick<Inbound, "provider" | "kind" | "team" | "channel" | "actor">) => ScopedKey;
};

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
	messages?: AppMessages;
	attachments?: AttachmentStore;
	http?: HttpRegistrar;
	store?: Store;
	approval?: ApprovalPolicy;
	memory?: Memory;
	app?: {
		agent: string;
		agentDirectory?: string;
		agentModel?: ModelConfig;
		runtime: { name: string; root: string };
		state: { root: string };
		task?: Required<TaskConfig>;
		approval?: ApprovalPolicy;
		memory: NormalizedMemoryConfig;
		skills?: NormalizedSkillsConfig;
		adapters: Array<{ name: string; kind: string; permissions?: PermissionsConfig }>;
		startedAt: number;
	};
};

/** Messaging platform boundary. Adapters translate provider events into `Inbound` messages. */
export interface Adapter {
	name: string;
	kind: string;
	permissions?: PermissionsConfig;
	acceptsBots?: boolean;
	start(input: AdapterStart): Promise<void>;
	ready?(input: AdapterStart): Promise<void>;
	send?(target: AdapterTarget, out: Outbound, input?: AdapterStart): Promise<void>;
	stop?(): Promise<void>;
}

export type HttpRoute = {
	method?: string;
	path: string;
	host?: string;
	port?: number | string;
	reserved?: boolean;
	handler(req: IncomingMessage, res: ServerResponse): void | Promise<void>;
};

export type HttpRegistrar = {
	register(route: HttpRoute): void;
	routes?(): Array<{ method: string; path: string; host: string; port: number | string; reserved: boolean }>;
	address?(): { host: string; port: number | string } | undefined;
};

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
	approval?: ApprovalPolicy;
	task?: TaskConfig;
	scope?: Scope;
	runtimeScope?: Scope;
	memoryScope?: Scope;
	skillsScope?: Scope;
	secrets?: Secrets;
	runtime?: (scope?: string) => Runtime;
	messages?: AppMessages;
	active?: ActiveRuns;
	lockMs?: number;
	logger?: Logger;
}): Handler {
	const agentId = input.agentId ?? "default";
	const log = input.logger ?? logger;
	const active = input.active ?? new ActiveRuns();
	const task = normalizeTask(input.task);
	const messages = input.messages ?? DEFAULT_APP_MESSAGES;
	const scopeFor = (msg: Pick<Inbound, "provider" | "kind" | "team" | "channel" | "actor">) =>
		resolveTurnScope({
			agent: agentId,
			provider: msg.provider,
			kind: msg.kind ?? msg.provider,
			team: msg.team,
			channel: msg.channel,
			actor: msg.actor,
			scope: input.scope,
			runtimeScope: input.runtimeScope,
			memoryScope: input.memoryScope,
			skillsScope: input.skillsScope,
		});
	const handle: Handler = async (msg) => {
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
		const messageText = intent.kind === "ask" ? text : rawText;
		const scheduled = msg.scheduled === true;
		const stream = intent.kind === "ask" || intent.kind === "approve" ? msg.stream : undefined;
		const runtimeEvents =
			msg.runtimeProgress && messages.runtimeStarting !== false
				? runtimeProgressEvents(msg.runtimeProgress, messages.runtimeStarting)
				: undefined;

		const thread = await input.store.threads.getOrCreate({
			agent: agentId,
			provider: msg.provider,
			kind: msg.kind ?? msg.provider,
			team: msg.team,
			channel: msg.channel,
			actor: msg.actor,
			key: msg.thread,
		});
		if (msg.providerMessageId && input.store.providerMessages) {
			await input.store.providerMessages.upsert({
				agent: agentId,
				provider: msg.provider,
				team: msg.team,
				channel: msg.channel,
				providerMessageId: msg.providerMessageId,
				threadId: thread.id,
				actor: msg.actor,
			});
		}
		const turnScope = scopeFor(msg);
		if (isSecretReply(rawText)) {
			return completeSecretReply({
				rawText,
				secrets: input.secrets,
				runtime: input.runtime,
				scope: turnScope.workspace,
				trace,
				agent: agentId,
				provider: msg.provider,
				channel: msg.channel,
				thread,
				actor: msg.actor,
				log,
			});
		}
		const lockKey = `thread:${thread.id}`;
		const lockOwner = `${trace}:${randomUUID()}`;
		if (intent.kind === "cancel") {
			const target = active.info(intent.id);
			// Do not reveal whether a run id exists in another thread.
			if (!target || target.threadId !== thread.id) return cancelReply("not_found", messages);
			if (!canCancelRun(task.cancel, input.approval, msg, target.actor))
				return cancelReply("unauthorized", messages);
			return cancelReply(active.cancel(intent.id, actorMention(msg)), messages);
		}
		if (intent.kind === "approvals") {
			if (!canListApprovals(input.approval, msg)) {
				return { text: messages.approvalsUnauthorized, private: true };
			}
			const channel = scopedChannelKey(msg);
			const rows = await input.store.approvals.listPending({ agent: agentId, channel, limit: 25 });
			return renderApprovals(rows);
		}
		if (intent.kind === "bypasses") {
			if (!canListApprovals(input.approval, msg)) {
				return { text: messages.approvalsUnauthorized, private: true };
			}
			if (!input.store.approvalBypasses) return { text: "Approval bypasses are not configured.", private: true };
			const channel = scopedChannelKey(msg);
			const all = await input.store.approvalBypasses.listActive({ agent: agentId, limit: 25 });
			const rows = all.filter((row) => bypassVisible(row, input.approval, msg, channel, thread.id));
			return renderApprovalBypasses(rows);
		}
		if (intent.kind === "thread_status") {
			const [turns, calls, approvals, currentLock] = await Promise.all([
				input.store.turns.listForThread(thread.id, { limit: 5 }),
				input.store.calls.listForThread(thread.id, {
					agent: agentId,
					states: ["running", "pending_approval"],
					limit: 5,
				}),
				input.store.approvals.listPending({ agent: agentId, threadId: thread.id, limit: 5 }),
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
		if (intent.kind === "approve" || intent.kind === "deny") {
			const channelKey = scopedChannelKey(msg);
			const controlBase: TurnContext = {
				trace,
				agent: agentId,
				provider: msg.provider,
				channel: channelKey,
				thread: thread.id,
				turn: "",
				message: "",
				actor: msg.actor,
				actorGroups: msg.actorGroups,
				actorBot: msg.actorBot,
				runtimeScope: turnScope.workspace.path,
				approval: input.approval,
			};
			try {
				let reply = await input.callRunner.handle(
					scopedIntent(intent as CallIntent, msg),
					controlBase,
					undefined,
					intent.kind === "approve" ? msg.ack : undefined,
					msg.replace,
					runtimeEvents,
				);
				const targetThreadId = reply.continuation?.threadId;
				if (reply.continuation) {
					if (!reply.continuation.turnId) throw new Error("approved call missing original turn");
					const continuationTurn = reply.continuation.turnId;
					controlBase.turn = continuationTurn;
					reply = await continueTool({
						store: input.store,
						agent: input.agent,
						channel: channelKey,
						provider: msg.provider,
						actor: msg.actor,
						trace,
						turn: continuationTurn,
						continuation: reply.continuation,
						scope: turnScope,
						stream,
						runtimeEvents,
						approval: input.approval,
					});
					if (reply.silent) {
						return await finishSilentTurn({
							store: input.store,
							turn: continuationTurn,
							aborted: false,
							scheduled,
							base: controlBase,
							logger: log,
						});
					}
					return await finishReplyTurn({
						store: input.store,
						turn: continuationTurn,
						threadId: targetThreadId ?? thread.id,
						provider: msg.provider,
						kind: msg.kind ?? msg.provider,
						reply,
						aborted: false,
						stream,
						finalPlacement: "progress",
						base: controlBase,
						attachmentScope: turnScope.workspace,
						logger: log,
					});
				}
				if (reply.silent) return scheduled ? { text: "", silent: true } : undefined;
				return {
					text: redact(reply.text),
					private: reply.private,
					silent: reply.silent,
					approval: reply.approval,
					approvalResolution: reply.approvalResolution,
					replaceOriginal: reply.replaceOriginal,
					attachments: reply.attachments,
					attachmentScope: turnScope.workspace,
				};
			} catch (error) {
				logError(log, "handler", {
					...controlBase,
					error: message(error),
				});
				return await finishSystemTurn({
					store: input.store,
					threadId: thread.id,
					provider: msg.provider,
					kind: msg.kind ?? msg.provider,
					text: userError(messages.error),
					state: "failed",
				});
			}
		}
		const shouldLock = requiresThreadLock(intent.kind) && input.store.locks !== undefined;
		let lock = shouldLock
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
			if (intent.kind === "ask" && task.busy !== "reject") {
				const duplicate = msg.eventId
					? await input.store.messages.getByProviderEvent(msg.provider, thread.id, msg.eventId)
					: undefined;
				if (duplicate) return undefined;
				const queued = await active.enqueue(
					lockKey,
					task.busy,
					attributedMessage(msg, messageText),
					msg.attachments,
					msg.eventId,
				);
				if (queued === "duplicate") return undefined;
				if (queued === "queued") {
					const created = await input.store.messages.createOnce({
						threadId: thread.id,
						provider: msg.provider,
						kind: msg.kind ?? msg.provider,
						providerEventId: msg.eventId,
						role: "user",
						actor: msg.actor,
						text: messageText,
						data: JSON.stringify(messageData(msg.data, trace, msg.attachments, msg.model)),
						state: "done",
					});
					if (!created.inserted) return undefined;
					const text = task.busy === "steer" ? messages.busySteer : messages.busyFollowUp;
					return { text, finalPlacement: "thread" };
				}
				lock = await input.store.locks?.acquire({ key: lockKey, owner: lockOwner, ttlMs: input.lockMs });
				if (lock) {
					log.debug("handler.lock_reacquired", {
						trace,
						agent: agentId,
						provider: msg.provider,
						channel: msg.channel,
						thread: msg.thread,
						event: msg.eventId,
					});
				}
			}
			if (!lock) return { text: messages.busyReject, finalPlacement: "thread" };
			// The active run ended between lock rejection and enqueue; handle this message as a fresh turn.
		}
		let turn: Awaited<ReturnType<Store["turns"]["create"]>> | undefined;
		let run: ReturnType<ActiveRuns["start"]> | undefined;
		let base: TurnContext | undefined;
		try {
			if (intent.kind === "ask") {
				const pending = (
					await input.store.approvals.listPending({ agent: agentId, threadId: thread.id, limit: 1 })
				)[0];
				if (pending) {
					log.debug("handler.pending_approval", {
						trace,
						agent: agentId,
						provider: msg.provider,
						channel: msg.channel,
						thread: thread.id,
						approval: pending.id,
					});
					return { text: messages.pendingApprovalReject, finalPlacement: "thread" };
				}
			}
			const created = await transaction(input.store, async (store) => {
				const inbound = await store.messages.createOnce({
					threadId: thread.id,
					provider: msg.provider,
					kind: msg.kind ?? msg.provider,
					providerEventId: msg.eventId,
					role: "user",
					actor: msg.actor,
					text: messageText,
					data: JSON.stringify(messageData(msg.data, trace, msg.attachments, msg.model)),
					state: "done",
				});
				if (!inbound.inserted) return { inbound };
				const turn = await store.turns.create({
					threadId: thread.id,
					inputMessageId: inbound.row.id,
					agent: agentId,
					provider: msg.provider,
					kind: msg.kind ?? msg.provider,
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
			const channelKey = scopedChannelKey(msg);
			base = {
				trace,
				agent: agentId,
				provider: msg.provider,
				channel: channelKey,
				thread: thread.id,
				turn: turn.id,
				message: inbound.row.id,
				actor: msg.actor,
				actorGroups: msg.actorGroups,
				actorBot: msg.actorBot,
				runtimeScope: turnScope.workspace.path,
				approval: input.approval,
			};

			log.debug("handler.intent", { ...base, kind: intent.kind });
			const currentBase = base;
			const currentTurn = turn;
			run = active.start([trace, currentTurn.id, lockKey], { actor: msg.actor, threadId: thread.id });
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
								channel: channelKey,
								channelName: msg.channelName,
								thread: msg.thread,
								threadName: msg.threadName,
								actor: intent.actor,
								actorName: msg.actorName,
								actorGroups: msg.actorGroups,
								trace,
								text: messageText,
								model: msg.model,
								scope: turnScope,
								attachments: msg.attachments,
								signal: currentRun.signal,
								stream,
								runtimeEvents,
								approval: input.approval,
								onLiveSession: (session) => {
									if (session) currentRun.attach(session);
									else currentRun.detach();
								},
							})
						: await input.callRunner.handle(
								scopedIntent(intent as CallIntent, msg),
								currentBase,
								currentRun.signal,
								undefined,
								undefined,
								runtimeEvents,
							);
			if (currentRun.signal.aborted) reply = { text: cancelText(messages, currentRun.cancelledBy()) };
			const targetThreadId = reply.continuation?.threadId;
			if (reply.continuation) {
				reply = await continueTool({
					store: input.store,
					agent: input.agent,
					channel: channelKey,
					provider: msg.provider,
					actor: msg.actor,
					trace,
					turn: currentTurn.id,
					continuation: reply.continuation,
					scope: turnScope,
					stream,
					runtimeEvents,
					approval: input.approval,
				});
			}
			if (reply.silent) {
				return await finishSilentTurn({
					store: input.store,
					turn: currentTurn.id,
					aborted: currentRun.signal.aborted,
					stream,
					scheduled,
					base: currentBase,
					logger: log,
				});
			}
			const finalPlacement = currentRun.additions() > 0 ? "thread" : "progress";
			return await finishReplyTurn({
				store: input.store,
				turn: currentTurn.id,
				threadId: targetThreadId ?? thread.id,
				provider: msg.provider,
				kind: msg.kind ?? msg.provider,
				reply,
				aborted: currentRun.signal.aborted,
				stream,
				finalPlacement,
				base: currentBase,
				attachmentScope: turnScope.workspace,
				logger: log,
			});
		} catch (error) {
			if ((run?.signal.aborted || isAbortError(error)) && turn) {
				await stream?.stop();
				return await finishSystemTurn({
					store: input.store,
					turn: turn.id,
					threadId: thread.id,
					provider: msg.provider,
					kind: msg.kind ?? msg.provider,
					text: cancelText(messages, run?.cancelledBy()),
					state: "cancelled",
				});
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
			return await finishSystemTurn({
				store: input.store,
				turn: turn?.id,
				threadId: thread.id,
				provider: msg.provider,
				kind: msg.kind ?? msg.provider,
				text: userError(messages.error),
				state: "failed",
			});
		} finally {
			if (lock) await input.store.locks?.release({ key: lockKey, owner: lockOwner });
			run?.stop();
		}
	};
	handle.attachmentScope = (msg) => scopeFor(msg).workspace;
	return handle;
}

export function createStatus(input: { agentId?: string; store: Store }): Status {
	const agentId = input.agentId ?? "default";
	return async ({ provider, team, threadId, runId }) => {
		const thread = await input.store.threads.getByKey(agentId, provider, team, threadId);
		if (!thread) return undefined;
		const turn = await input.store.turns.getByTrace(thread.id, runId);
		if (!turn) return undefined;
		const result = turn.resultMessageId ? await input.store.messages.get(turn.resultMessageId) : undefined;
		const approval = (
			await input.store.approvals.listPending({ agent: agentId, threadId: thread.id, turnId: turn.id, limit: 1 })
		)[0];
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

function runtimeProgressEvents(progress: RuntimeProgress, text: string): RuntimeEventHandler {
	let last = "";
	return (event) => {
		if (event.kind !== "starting") return;
		if (text === last) return;
		last = text;
		void Promise.resolve(progress.update(text)).catch(() => undefined);
	};
}

function messageData(
	input: unknown,
	trace: string,
	attachments?: Attachment[],
	model?: ModelConfig,
): Record<string, unknown> {
	const files = attachments?.length ? { attachments } : {};
	const override = model ? { model } : {};
	if (input && typeof input === "object" && !Array.isArray(input)) {
		return { ...(input as Record<string, unknown>), ...files, ...override, trace };
	}
	if (input === undefined) return { ...files, ...override, trace };
	return { ...files, ...override, trace, data: input };
}
