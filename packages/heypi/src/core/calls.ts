import type { ApprovalPolicy } from "../config.js";
import { runtimeWithEvents } from "../runtime/events.js";
import type { Queue } from "../runtime/queue.js";
import type { Runtime, RuntimeEventHandler } from "../runtime/types.js";
import type { Approval, ApprovalBypasses, Approvals, Call, Calls, Store } from "../store/types.js";
import * as approvalBypass from "./approval-bypass.js";
import { parseApprovalDetails, serializeApprovalDetails } from "./approval-view.js";
import { actorAllowed, actorLabels, actorMatches, hasActorPolicy } from "./approvers.js";
import { executeBashCall, executeToolCall } from "./call-exec.js";
import * as callReply from "./call-reply.js";
import { renderCall } from "./format.js";
import { type Logger, logger } from "./log.js";
import { type AppMessages, DEFAULT_APP_MESSAGES, renderMessage } from "./messages.js";
import { assertTransition, parseCallState } from "./state.js";
import type { ApprovalDetail, ApprovalResolution, Confirm, Intent, Reply, ToolExecute } from "./types.js";

export const RUNTIME_EVENTS = Symbol("runtime-events");

export type CallContext = {
	trace?: string;
	agent?: string;
	thread?: string;
	turn?: string;
	message?: string;
	toolCall?: string;
	actorGroups?: string[];
	actorBot?: boolean;
	runtimeScope?: string;
	approval?: ApprovalPolicy;
	[RUNTIME_EVENTS]?: RuntimeEventHandler;
};

type CallBase = {
	channel: string;
	actor: string;
	tool: string;
	args: Record<string, unknown>;
	command?: string;
	runtime?: string;
	details?: ApprovalDetail[];
	policyReason: string;
	context?: CallContext;
};

type PendingApprovalResult = { ok: true; approval: Approval } | { ok: false; reply: Reply };

/** Runs governed calls through policy, approval, queueing, runtime execution, and audit persistence. */
export class CallRunner {
	private readonly executes = new Map<string, ToolExecute>();

	constructor(
		private readonly calls: Calls,
		private readonly approvals: Approvals,
		private readonly queue: Queue,
		private readonly runtime: Runtime | ((scope?: string) => Runtime),
		private readonly approval: ApprovalPolicy = {},
		private readonly log: Logger = logger,
		private readonly transaction?: Store["transaction"],
		private readonly bashConfirm?: Confirm,
		private readonly messages: AppMessages = DEFAULT_APP_MESSAGES,
		private readonly agent = "default",
		private readonly approvalBypasses?: ApprovalBypasses,
	) {}

	register(tool: string, execute: ToolExecute): void {
		this.executes.set(tool, execute);
	}

	async handle(
		intent: Exclude<Intent, { kind: "ask" | "help" | "cancel" | "approvals" | "thread_status" }>,
		context: CallContext = {},
		signal?: AbortSignal,
		onApproved?: (reply: Reply) => Promise<void>,
		onExpired?: (reply: Reply) => Promise<void>,
		runtimeEvents?: RuntimeEventHandler,
	): Promise<Reply> {
		const eventContext = withRuntimeEvents(context, runtimeEvents);
		if (intent.kind === "bash") return this.bash(intent.channel, intent.actor, intent.cmd, eventContext, signal);
		if (intent.kind === "approve") return this.handleApprove(intent, eventContext, signal, onApproved, onExpired);
		if (intent.kind === "deny") return this.handleDeny(intent, eventContext, onExpired);
		if (intent.kind === "revoke") return this.handleRevoke(intent, eventContext);
		return this.handleStatus(intent, eventContext);
	}

	async bash(
		channel: string,
		actor: string,
		command: string,
		context: CallContext = {},
		signal?: AbortSignal,
	): Promise<Reply> {
		const runtime = this.runtimeFor(context.runtimeScope, context[RUNTIME_EVENTS]);
		if (!runtime.bash) throw new Error(`runtime ${runtime.name} does not support bash`);
		const confirmation = confirm(this.bashConfirm, { command });
		const details = normalizeConfirmationDetails(confirmation?.details);
		const base = {
			channel,
			actor,
			tool: "bash",
			command,
			args: compact({ command }),
			runtime: runtime.name,
			details,
			policyReason: confirmation?.policyReason ?? confirmation?.reason ?? "tool default",
			context,
		};
		if (confirmation?.block) return this.block(base, confirmation.block);
		if (confirmation && !(await this.bypassActive(base))) return this.requestApproval(base, confirmation.reason);
		const row = await this.createCall(base, "running");
		return this.executeBash(row.id, channel, actor, command, context, signal);
	}

	async tool(input: {
		channel: string;
		actor: string;
		name: string;
		args: Record<string, unknown>;
		confirm?: Confirm;
		context?: CallContext;
		execute: ToolExecute;
		signal?: AbortSignal;
	}): Promise<Reply> {
		const confirmation = confirm(input.confirm, input.args);
		const details = normalizeConfirmationDetails(confirmation?.details);
		const base = {
			channel: input.channel,
			actor: input.actor,
			tool: input.name,
			args: input.args,
			details,
			policyReason: confirmation?.policyReason ?? confirmation?.reason ?? "tool default",
			context: input.context,
		};
		if (confirmation?.block) return this.block(base, confirmation.block);
		if (confirmation && !(await this.bypassActive(base))) return this.requestApproval(base, confirmation.reason);
		const row = await this.createCall(base, "running");
		return this.executeTool(
			row.id,
			input.name,
			input.actor,
			input.args,
			input.execute,
			input.context ?? {},
			input.signal,
		);
	}

	private async block(input: CallBase, reason: string): Promise<Reply> {
		const row = await this.createCall(input, "blocked");
		return renderCall({ callId: row.id, state: row.state, reason });
	}

	private async requestApproval(input: CallBase, reason: string): Promise<Reply> {
		const row = await this.createCall(input, "pending_approval");
		const agent = this.contextAgent(input.context);
		const approval = await this.approvals.create({
			agent,
			callId: row.id,
			channel: input.channel,
			threadId: input.context?.thread,
			turnId: input.context?.turn,
			requestMessageId: input.context?.message,
			requestedBy: input.actor,
			expiresAt: this.expiresAt(),
			command: input.command ?? input.tool,
			runtime: input.runtime ?? "tool",
			reason,
			details: serializeApprovalDetails(input.details),
			snapshot: callReply.callSnapshot(row),
		});
		this.log.info("approval.created", {
			...input.context,
			channel: input.channel,
			call: row.id,
			approval: approval.id,
			reason,
		});
		return renderCall({
			callId: row.id,
			state: row.state,
			approvalId: approval.id,
			reason,
			command: input.command ?? `${input.tool} ${JSON.stringify(input.args)}`,
			runtime: input.runtime ?? "tool",
			approvers: this.approvers(),
			requestedBy: input.actor,
			details: normalizeConfirmationDetails(input.details),
		});
	}

	private async createCall(input: CallBase, state: "running" | "pending_approval" | "blocked") {
		return await this.calls.create({
			agent: this.contextAgent(input.context),
			turnId: input.context?.turn,
			threadId: input.context?.thread,
			messageId: input.context?.message,
			toolCallId: input.context?.toolCall,
			channel: input.channel,
			actor: input.actor,
			tool: input.tool,
			command: input.command,
			args: callReply.callArgsForStorage(input.args, input.context),
			runtime: input.runtime,
			state,
			policyReason: input.policyReason,
		});
	}

	private async executeBash(
		callId: string,
		channel: string,
		actor: string | null | undefined,
		command: string,
		context: CallContext,
		signal?: AbortSignal,
	): Promise<Reply> {
		return executeBashCall({
			callId,
			channel,
			actor,
			command,
			context,
			signal,
			queue: this.queue,
			runtime: this.runtimeFor(context.runtimeScope, context[RUNTIME_EVENTS]),
			calls: this.calls,
			log: this.log,
			messages: this.messages,
		});
	}

	private async executeTool(
		callId: string,
		tool: string,
		actor: string | null | undefined,
		args: Record<string, unknown>,
		execute: ToolExecute,
		context: CallContext,
		signal?: AbortSignal,
	): Promise<Reply> {
		return executeToolCall({
			callId,
			tool,
			actor,
			args,
			execute,
			context,
			signal,
			runtime: this.runtimeFor(context.runtimeScope, context[RUNTIME_EVENTS]),
			calls: this.calls,
			log: this.log,
			messages: this.messages,
		});
	}

	private async handleApprove(
		intent: Extract<Intent, { kind: "approve" }>,
		context: CallContext,
		signal?: AbortSignal,
		onApproved?: (reply: Reply) => Promise<void>,
		onExpired?: (reply: Reply) => Promise<void>,
	): Promise<Reply> {
		const pending = await this.pendingApproval(intent, this.contextAgent(context));
		if (!pending.ok) return pending.reply;
		const { approval } = pending;
		const policy = this.policy(context);
		if (
			!this.canApprove(
				intent.actor,
				context.actorGroups,
				approval.requestedBy ?? undefined,
				policy,
				context.actorBot,
			)
		) {
			this.log.warn("approval.unauthorized", {
				approval: approval.id,
				call: approval.callId,
				channel: approval.channel,
				actor: intent.actor,
				requestedBy: approval.requestedBy ?? undefined,
			});
			return renderCall({
				callId: approval.callId,
				state: "unauthorized",
				approvers: this.approvers(policy),
				messages: this.messages,
			});
		}
		if (this.expired(approval.expiresAt)) return this.expireApproval(approval, intent.actor, onExpired);
		const current = await this.calls.get(approval.callId, { agent: approval.agent });
		if (!current) throw new Error("call not found");
		assertTransition(parseCallState(current.state), "running");
		if (!this.approvalMatchesCall(approval, current)) {
			this.log.warn("approval.call_mismatch", {
				approval: approval.id,
				call: approval.callId,
				channel: approval.channel,
				actor: intent.actor,
			});
			const resolved = await this.updateApprovalCall(
				approval.id,
				"denied",
				intent.actor,
				approval.callId,
				"blocked",
				approval.agent,
			);
			if (!resolved) return callReply.staleApproval(this.messages.approvalResolved);
			return callReply.staleApproval("Approval no longer matches the pending action. Recreate the request.");
		}
		if (intent.bypass) {
			if (!this.approvalBypasses) return { text: "Approval bypasses are not configured.", private: true };
			if (!approvalBypass.config(policy)) return { text: "Approval bypasses are disabled.", private: true };
		}
		if (
			!(await this.updateApprovalCall(
				approval.id,
				"approved",
				intent.actor,
				approval.callId,
				"running",
				approval.agent,
			))
		) {
			this.log.info("approval.already_resolved", {
				approval: approval.id,
				call: approval.callId,
				channel: approval.channel,
				actor: intent.actor,
				state: "resolved",
			});
			return callReply.staleApproval(this.messages.approvalResolved);
		}
		let bypass: Awaited<ReturnType<ApprovalBypasses["create"]>> | undefined;
		if (intent.bypass) {
			try {
				bypass = await approvalBypass.create({
					approval,
					call: current,
					actor: intent.actor,
					context,
					policy,
					approvalBypasses: this.approvalBypasses,
					log: this.log,
				});
			} catch (error) {
				this.log.warn("approval_bypass.create_failed", {
					approval: approval.id,
					call: approval.callId,
					channel: approval.channel,
					actor: intent.actor,
					error: error instanceof Error ? error.message : String(error),
				});
			}
		}
		this.log.info("approval.approved", {
			approval: approval.id,
			call: approval.callId,
			channel: approval.channel,
			actor: intent.actor,
			tool: current.tool,
			thread: current.threadId ?? undefined,
			turn: current.turnId ?? undefined,
			bypass: bypass?.id,
		});
		if (onApproved) {
			try {
				await onApproved(this.approvalSummary(approval, current, "approved", policy));
			} catch (error) {
				this.log.warn("approval.ack_failed", {
					approval: approval.id,
					call: approval.callId,
					channel: approval.channel,
					actor: intent.actor,
					error: error instanceof Error ? error.message : String(error),
				});
			}
		}
		if (current.tool === "bash") {
			const approvedContext = withRuntimeEvents(callReply.callContext(current), context[RUNTIME_EVENTS]);
			const runtime = this.runtimeFor(approvedContext.runtimeScope, approvedContext[RUNTIME_EVENTS]);
			if (approval.runtime !== runtime.name) throw new Error(`approval runtime mismatch: ${approval.runtime}`);
			if (!current.command) throw new Error("approved bash call missing command");
			return this.executeBash(
				approval.callId,
				approval.channel,
				current.actor,
				current.command,
				approvedContext,
				signal,
			);
		}
		const execute = this.executes.get(current.tool);
		if (!execute) throw new Error(`approved tool not registered: ${current.tool}`);
		return this.executeTool(
			approval.callId,
			current.tool,
			current.actor,
			callReply.callArgs(current.args),
			execute,
			withRuntimeEvents(callReply.callContext(current), context[RUNTIME_EVENTS]),
			signal,
		);
	}

	private async handleRevoke(intent: Extract<Intent, { kind: "revoke" }>, context: CallContext): Promise<Reply> {
		if (!this.approvalBypasses) return { text: "Approval bypasses are not configured.", private: true };
		const policy = this.policy(context);
		if (!this.canApprove(intent.actor, context.actorGroups, undefined, policy, context.actorBot)) {
			this.log.warn("approval_bypass.unauthorized_revoke", {
				bypass: intent.bypassId,
				channel: intent.channel,
				actor: intent.actor,
			});
			return renderCall({
				callId: intent.bypassId,
				state: "unauthorized",
				approvers: this.approvers(policy),
				messages: this.messages,
			});
		}
		const revoked = await this.approvalBypasses.revoke(intent.bypassId, intent.actor, {
			agent: this.contextAgent(context),
		});
		if (!revoked) return { text: "Approval bypass not found or already revoked.", private: true };
		this.log.info("approval_bypass.revoked", {
			bypass: intent.bypassId,
			channel: intent.channel,
			actor: intent.actor,
		});
		return { text: `Approval bypass revoked: ${intent.bypassId}`, private: true };
	}

	private async handleDeny(
		intent: Extract<Intent, { kind: "deny" }>,
		context: CallContext,
		onExpired?: (reply: Reply) => Promise<void>,
	): Promise<Reply> {
		const pending = await this.pendingApproval(intent, this.contextAgent(context));
		if (!pending.ok) return pending.reply;
		const { approval } = pending;
		const policy = this.policy(context);
		if (
			!this.canDeny(intent.actor, context.actorGroups, approval.requestedBy ?? undefined, policy, context.actorBot)
		) {
			this.log.warn("approval.unauthorized", {
				approval: approval.id,
				call: approval.callId,
				channel: approval.channel,
				actor: intent.actor,
				requestedBy: approval.requestedBy ?? undefined,
			});
			return renderCall({
				callId: approval.callId,
				state: "unauthorized",
				approvers: this.approvers(policy),
				messages: this.messages,
			});
		}
		if (this.expired(approval.expiresAt)) return this.expireApproval(approval, intent.actor, onExpired);
		const current = await this.calls.get(approval.callId, { agent: approval.agent });
		if (!current) throw new Error("call not found");
		assertTransition(parseCallState(current.state), "blocked");
		if (
			!(await this.updateApprovalCall(
				approval.id,
				"denied",
				intent.actor,
				approval.callId,
				"blocked",
				approval.agent,
			))
		) {
			this.log.info("approval.already_resolved", {
				approval: approval.id,
				call: approval.callId,
				channel: approval.channel,
				actor: intent.actor,
				state: "resolved",
			});
			return callReply.staleApproval(this.messages.approvalResolved);
		}
		this.log.info("approval.denied", {
			approval: approval.id,
			call: approval.callId,
			channel: approval.channel,
			actor: intent.actor,
			tool: current.tool,
			thread: current.threadId ?? undefined,
			turn: current.turnId ?? undefined,
		});
		return this.approvalSummary(approval, current, "rejected", policy);
	}

	private async pendingApproval(
		intent: Extract<Intent, { kind: "approve" | "deny" }>,
		agent: string,
	): Promise<PendingApprovalResult> {
		const approval = await this.approvals.getByChannel(intent.channel, intent.approvalId, { agent });
		if (!approval) return { ok: false, reply: callReply.staleApproval(this.messages.approvalUnavailable) };
		if (approval.state !== "pending") {
			this.log.info("approval.already_resolved", {
				approval: approval.id,
				call: approval.callId,
				channel: approval.channel,
				actor: intent.actor,
				state: approval.state,
				resolvedBy: approval.resolvedBy ?? undefined,
			});
			return {
				ok: false,
				reply: callReply.staleApproval(
					renderMessage(this.messages.approvalAlreadyResolved, {
						state: approval.state,
						resolvedBy: approval.resolvedBy ?? undefined,
					}),
				),
			};
		}
		return { ok: true, approval };
	}

	private async updateApprovalCall(
		approvalId: string,
		approvalState: "approved" | "denied" | "expired",
		actor: string,
		callId: string,
		callState: "running" | "blocked",
		agent: string,
	): Promise<boolean> {
		if (!this.transaction) {
			const resolved = await this.approvals.resolve(approvalId, approvalState, actor, { agent });
			if (resolved) await this.calls.setState(callId, callState, { agent });
			return resolved;
		}
		return await this.transaction(async (store) => {
			const resolved = await store.approvals.resolve(approvalId, approvalState, actor, { agent });
			if (resolved) await store.calls.setState(callId, callState, { agent });
			return resolved;
		});
	}

	private canApprove(
		actor: string,
		groups: string[] | undefined,
		requestedBy: string | undefined,
		policy: ApprovalPolicy,
		actorBot = false,
	): boolean {
		if (policy.allowSelfApproval === false && requestedBy && actor === requestedBy) return false;
		const identity = { actor, groups };
		if (actorMatches(policy.admins, identity)) return true;
		if (actorMatches(policy.approvers, identity)) return true;
		if (actorBot) return false;
		if (!hasActorPolicy(policy.admins) && !hasActorPolicy(policy.approvers)) return actorAllowed(undefined, identity);
		return false;
	}

	private canDeny(
		actor: string,
		groups: string[] | undefined,
		requestedBy: string | undefined,
		policy: ApprovalPolicy,
		actorBot = false,
	): boolean {
		if (this.canApprove(actor, groups, requestedBy, policy, actorBot)) return true;
		return !actorBot && actor === requestedBy;
	}

	private async bypassActive(input: CallBase): Promise<boolean> {
		return approvalBypass.active({
			base: input,
			policy: this.policy(input.context),
			agent: this.contextAgent(input.context),
			approvalBypasses: this.approvalBypasses,
			log: this.log,
		});
	}

	private approvers(policy = this.approval): string[] {
		return [...new Set([...actorLabels(policy.approvers), ...actorLabels(policy.admins)])];
	}

	private expiresAt(): number | undefined {
		if (!this.approval.expiresInMs) return undefined;
		return Date.now() + this.approval.expiresInMs;
	}

	private expired(expiresAt: number | null): boolean {
		return typeof expiresAt === "number" && expiresAt <= Date.now();
	}

	private async expireApproval(
		approval: Approval,
		actor: string,
		onExpired?: (reply: Reply) => Promise<void>,
	): Promise<Reply> {
		const resolved = await this.updateApprovalCall(
			approval.id,
			"expired",
			"heypi",
			approval.callId,
			"blocked",
			approval.agent,
		);
		if (!resolved) {
			this.log.info("approval.already_resolved", {
				approval: approval.id,
				call: approval.callId,
				channel: approval.channel,
				actor,
				state: "resolved",
			});
			return { text: this.messages.approvalResolved, private: true };
		}
		this.log.info("approval.expired", {
			approval: approval.id,
			call: approval.callId,
			channel: approval.channel,
			actor,
			expiresAt: approval.expiresAt ?? undefined,
		});
		const current = await this.calls.get(approval.callId, { agent: approval.agent });
		const summary = current ? this.approvalSummary(approval, current, "expired") : undefined;
		const reply = {
			...(summary ?? {}),
			text: [summary?.text, this.messages.approvalExpired].filter(Boolean).join("\n\n"),
			approvalResolution: "expired" as const,
		};
		if (onExpired) {
			try {
				await onExpired(reply);
				return { text: "", silent: true };
			} catch (error) {
				this.log.warn("approval.expired_ack_failed", {
					approval: approval.id,
					call: approval.callId,
					channel: approval.channel,
					actor,
					error: error instanceof Error ? error.message : String(error),
				});
			}
		}
		return { text: this.messages.approvalExpired, private: true };
	}

	private approvalSummary(
		approval: {
			id: string;
			callId: string;
			reason: string;
			runtime: string;
			requestedBy?: string | null;
			details?: string | null;
		},
		call: { tool: string; command: string | null; args: string | null },
		resolution?: ApprovalResolution,
		policy = this.approval,
	): Reply {
		return callReply.approvalSummary(approval, call, this.approvers(policy), resolution);
	}

	private approvalMatchesCall(approval: Approval, call: Call): boolean {
		return approval.snapshot === callReply.callSnapshot(call);
	}

	private async handleStatus(intent: Extract<Intent, { kind: "status" }>, context: CallContext): Promise<Reply> {
		const row = await this.calls.getByChannel(intent.channel, intent.callId, { agent: this.contextAgent(context) });
		if (!row) return { text: "Call not found.", private: true };
		return renderCall({
			callId: row.id,
			state: row.state,
			code: row.code ?? undefined,
			out: row.out ?? undefined,
			err: row.err ?? undefined,
			errKind: row.errKind,
			ms: row.ms ?? undefined,
			messages: this.messages,
		});
	}

	private runtimeFor(scope?: string, runtimeEvents?: RuntimeEventHandler): Runtime {
		const runtime = typeof this.runtime === "function" ? this.runtime(scope) : this.runtime;
		return runtimeWithEvents(runtime, runtimeEvents);
	}

	private contextAgent(context?: CallContext): string {
		return context?.agent ?? this.agent;
	}

	private policy(context?: CallContext): ApprovalPolicy {
		return context?.approval ?? this.approval;
	}
}

function withRuntimeEvents(context: CallContext, runtimeEvents?: RuntimeEventHandler): CallContext {
	if (!runtimeEvents) return context;
	return { ...context, [RUNTIME_EVENTS]: runtimeEvents };
}

function confirm(
	input: Confirm | undefined,
	args: Record<string, unknown>,
):
	| {
			reason: string;
			policyReason?: string;
			block?: string;
			details?: ApprovalDetail[];
	  }
	| undefined {
	if (!input) return undefined;
	const out = typeof input === "function" ? input(args) || undefined : input;
	if (!out) return undefined;
	return {
		reason: out.message ?? out.reason ?? "Approval required.",
		policyReason: out.policyReason,
		block: out.block,
		details: out.details,
	};
}

function normalizeConfirmationDetails(details: ApprovalDetail[] | undefined): ApprovalDetail[] | undefined {
	if (details === undefined) return undefined;
	return parseApprovalDetails(serializeApprovalDetails(details)) ?? [];
}

function compact<T extends Record<string, unknown>>(input: T): T {
	return Object.fromEntries(Object.entries(input).filter(([, value]) => value !== undefined)) as T;
}
