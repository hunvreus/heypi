import { randomUUID } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { ApprovalConfig, ChatConfig, ModelConfig, Scope } from "../config.js";
import { ActiveRuns, cancelReply, isAbortError } from "../core/active.js";
import { actorAllowed, actorMatches, hasActorPolicy } from "../core/approvers.js";
import type { CallRunner } from "../core/calls.js";
import { helpReply, renderApprovals, renderThreadStatus } from "../core/format.js";
import { normalizeText, parseIntent } from "../core/intent.js";
import { type Logger, logError, logger, message, redact, userError } from "../core/log.js";
import type { MemoryStore, NormalizedMemoryConfig } from "../core/memory.js";
import { type AppMessages, DEFAULT_APP_MESSAGES } from "../core/messages.js";
import type { ScopedKey, TurnScope } from "../core/scope.js";
import { resolveScope, selectScope } from "../core/scope.js";
import { isSecretReply, type SecretStore } from "../core/secrets.js";
import type { NormalizedSkillsConfig } from "../core/skills.js";
import type { ApprovalPrompt, ApprovalResolution, Intent, ReplyAttachment } from "../core/types.js";
import type { Agent } from "../runtime/agent.js";
import type { Runtime, RuntimeEventHandler } from "../runtime/types.js";
import { transaction } from "../store/transaction.js";
import { continueTool, saveReply } from "../store/transcript.js";
import type { Store } from "../store/types.js";
import { type Attachment, type AttachmentStore, attachmentPrompt } from "./attachments.js";
import type { ReplyStream } from "./reply-stream.js";

export type Inbound = {
	trace?: string;
	provider: string;
	kind?: string;
	eventId?: string;
	team?: string;
	channel: string;
	channelName?: string;
	actor: string;
	actorName?: string;
	actorGroups?: string[];
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
	approval?: ApprovalConfig;
	memory?: MemoryStore;
	app?: {
		agent: string;
		agentDirectory?: string;
		agentModel?: ModelConfig;
		runtime: { name: string; root: string };
		state: { root: string };
		memory: NormalizedMemoryConfig;
		skills?: NormalizedSkillsConfig;
		adapters: Array<{ name: string; kind: string }>;
		startedAt: number;
	};
};

/** Messaging platform boundary. Adapters translate provider events into `Inbound` messages. */
export interface Adapter {
	name: string;
	kind: string;
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

type HandlerBase = {
	trace: string;
	agent: string;
	provider: string;
	channel: string;
	thread: string;
	turn: string;
	message: string;
	actor: string;
	actorGroups?: string[];
	runtimeScope?: string;
};

/** Creates the provider-neutral handler shared by Slack, Telegram, and future adapters. */
export function createHandler(input: {
	agentId?: string;
	store: Store;
	callRunner: CallRunner;
	agent: Agent;
	approval?: ApprovalConfig;
	chat?: ChatConfig;
	scope?: Scope;
	runtimeScope?: Scope;
	memoryScope?: Scope;
	skillsScope?: Scope;
	secrets?: SecretStore;
	runtime?: (scope?: string) => Runtime;
	messages?: AppMessages;
	active?: ActiveRuns;
	lockMs?: number;
	logger?: Logger;
}): Handler {
	const agentId = input.agentId ?? "default";
	const log = input.logger ?? logger;
	const active = input.active ?? new ActiveRuns();
	const chat = normalizeChat(input.chat);
	const messages = input.messages ?? DEFAULT_APP_MESSAGES;
	const scopeFor = (msg: Pick<Inbound, "provider" | "kind" | "team" | "channel" | "actor">): TurnScope => {
		const keys = resolveScope({
			agent: agentId,
			provider: msg.provider,
			kind: msg.kind ?? msg.provider,
			team: msg.team,
			channel: msg.channel,
			actor: msg.actor,
		});
		return {
			workspace: selectScope(keys, input.runtimeScope ?? input.scope),
			memory: selectScope(keys, input.memoryScope ?? input.scope),
			skills: selectScope(keys, input.skillsScope ?? input.scope),
			keys,
		};
	};
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
		const stream = intent.kind === "ask" ? msg.stream : undefined;
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
		const turnScope = scopeFor(msg);
		if (isSecretReply(rawText)) {
			try {
				const completed = input.secrets?.complete(rawText, turnScope.workspace);
				if (!completed) return { text: "Secret request expired, invalid, or for another scope.", private: true };
				const runtime = input.runtime?.(turnScope.workspace.path);
				const write = runtime?.write?.bind(runtime);
				if (!write) throw new Error("selected runtime does not support writing secret files");
				await Promise.all(completed.files.map((file) => write({ path: file.path, content: file.value })));
				log.info("secret.saved", {
					trace,
					agent: agentId,
					provider: msg.provider,
					channel: msg.channel,
					thread: thread.id,
					actor: msg.actor,
					fields: completed.files.map((file) => file.name).join(","),
				});
				return { text: `Secret saved: ${completed.files.map((file) => file.path).join(", ")}`, private: true };
			} catch (error) {
				logError(log, "handler", {
					trace,
					agent: agentId,
					provider: msg.provider,
					channel: msg.channel,
					thread: thread.id,
					actor: msg.actor,
					error: message(error),
				});
				return { text: "Secret could not be saved. Request a fresh secret link and try again.", private: true };
			}
		}
		const lockKey = `thread:${thread.id}`;
		const lockOwner = `${trace}:${randomUUID()}`;
		if (intent.kind === "cancel") {
			const target = active.info(intent.id);
			// Do not reveal whether a run id exists in another thread.
			if (!target || target.threadId !== thread.id) return cancelReply("not_found", messages);
			if (!canCancelRun(input.approval, msg, target.actor)) return cancelReply("unauthorized", messages);
			return cancelReply(active.cancel(intent.id), messages);
		}
		if (intent.kind === "approvals") {
			if (!canListApprovals(input.approval, msg)) {
				return { text: messages.approvalsUnauthorized, private: true };
			}
			const all = await input.store.approvals.listPending({ agent: agentId, limit: 25 });
			const rows = all.filter((row) => approvalVisible(row, input.approval, msg, thread.id));
			return renderApprovals(rows);
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
			if (intent.kind === "ask" && chat.busy !== "reject" && active.has(lockKey)) {
				const created = await input.store.messages.createOnce({
					threadId: thread.id,
					provider: msg.provider,
					kind: msg.kind ?? msg.provider,
					providerEventId: msg.eventId,
					role: "user",
					actor: msg.actor,
					text: messageText,
					data: JSON.stringify(data(msg.data, trace, msg.attachments, msg.model)),
					state: "done",
				});
				if (!created.inserted) return undefined;
				const queued = await active.enqueue(
					lockKey,
					chat.busy,
					attributedMessage(msg, messageText),
					msg.attachments,
				);
				if (queued === "queued") {
					const text = chat.busy === "steer" ? messages.busySteer : messages.busyFollowUp;
					return { text, finalPlacement: "thread" };
				}
			}
			return { text: messages.busyReject, finalPlacement: "thread" };
		}
		let turn: Awaited<ReturnType<Store["turns"]["create"]>> | undefined;
		let run: ReturnType<ActiveRuns["start"]> | undefined;
		let base: HandlerBase | undefined;
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
					data: JSON.stringify(data(msg.data, trace, msg.attachments, msg.model)),
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
			base = {
				trace,
				agent: agentId,
				provider: msg.provider,
				channel: scopeKey(msg),
				thread: thread.id,
				turn: turn.id,
				message: inbound.row.id,
				actor: msg.actor,
				actorGroups: msg.actorGroups,
				runtimeScope: turnScope.workspace.path,
			};

			log.debug("handler.intent", { ...base, kind: intent.kind });
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
								channel: scopeKey(msg),
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
								onLiveSession: (session) => {
									if (session) currentRun.attach(session);
									else currentRun.detach();
								},
							})
						: await input.callRunner.handle(
								scopedIntent(intent as CallIntent, msg),
								base,
								currentRun.signal,
								intent.kind === "approve" ? msg.ack : undefined,
								intent.kind === "approve" || intent.kind === "deny" ? msg.replace : undefined,
								runtimeEvents,
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
					scope: turnScope,
					stream,
					runtimeEvents,
				});
			}
			if (reply.silent) {
				return await finishSilentTurn({
					store: input.store,
					turn: currentTurn.id,
					aborted: currentRun.signal.aborted,
					stream,
					scheduled,
					base,
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
				base,
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
					text: "cancelled",
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

async function finishSilentTurn(input: {
	store: Store;
	turn: string;
	aborted: boolean;
	stream?: ReplyStream;
	scheduled: boolean;
	base: HandlerBase;
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

async function finishReplyTurn(input: {
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
	base: HandlerBase;
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

async function finishSystemTurn(input: {
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

function canListApprovals(config: ApprovalConfig | undefined, actor: Pick<Inbound, "actor" | "actorGroups">): boolean {
	return actorAllowedForApproval(config, actor);
}

function canCancelRun(
	config: ApprovalConfig | undefined,
	actor: Pick<Inbound, "actor" | "actorGroups">,
	initiator?: string,
): boolean {
	return (
		actor.actor === initiator ||
		(hasActorPolicy(config?.approvers) || hasActorPolicy(config?.admins)
			? actorAllowedForApproval(config, actor)
			: false)
	);
}

function actorAllowedForApproval(
	config: ApprovalConfig | undefined,
	actor: Pick<Inbound, "actor" | "actorGroups">,
): boolean {
	const identity = { actor: actor.actor, groups: actor.actorGroups };
	if (actorMatches(config?.admins, identity)) return true;
	if (actorMatches(config?.approvers, identity)) return true;
	if (!hasActorPolicy(config?.admins) && !hasActorPolicy(config?.approvers)) return actorAllowed(undefined, identity);
	return false;
}

function approvalVisible(
	row: { channel: string; threadId: string | null },
	config: ApprovalConfig | undefined,
	msg: Pick<Inbound, "provider" | "team">,
	threadId: string,
): boolean {
	if (!hasActorPolicy(config?.approvers) && !hasActorPolicy(config?.admins)) return row.threadId === threadId;
	return row.channel.startsWith(`${msg.provider}:${msg.team ?? ""}:`);
}

type NormalizedChat = Required<ChatConfig>;

function normalizeChat(input: ChatConfig | undefined): NormalizedChat {
	return {
		busy: input?.busy ?? "steer",
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

function attributedMessage(msg: Pick<Inbound, "actor" | "actorName">, text: string): string {
	const actor = msg.actorName && msg.actorName !== msg.actor ? `${msg.actorName} (${msg.actor})` : msg.actor;
	return `[Message from ${actor}]\n${text}`;
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
