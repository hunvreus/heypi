import type { ApprovalConfig } from "../config.js";
import type { Queue } from "../runtime/queue.js";
import type { Runtime } from "../runtime/types.js";
import type { Approvals, Calls, Store } from "../store/types.js";
import { isAbortError } from "./active.js";
import { renderCall } from "./format.js";
import { type Logger, logger } from "./log.js";
import { classifyCommand } from "./policy.js";
import { assertTransition, parseCallState } from "./state.js";
import type { CommandPolicyConfig, Confirm, Intent, Reply, ToolExecute } from "./types.js";

export type CallContext = {
	trace?: string;
	agent?: string;
	thread?: string;
	turn?: string;
	message?: string;
	toolCall?: string;
};

type CallBase = {
	channel: string;
	actor: string;
	tool: string;
	args: Record<string, unknown>;
	command?: string;
	runtime?: string;
	policyReason: string;
	context?: CallContext;
};

/** Runs governed calls through policy, approval, queueing, runtime execution, and audit persistence. */
export class CallRunner {
	private readonly executes = new Map<string, ToolExecute>();

	constructor(
		private readonly calls: Calls,
		private readonly approvals: Approvals,
		private readonly queue: Queue,
		private readonly runtime: Runtime,
		private readonly approval: ApprovalConfig = {},
		private readonly log: Logger = logger,
		private readonly transaction?: Store["transaction"],
		private readonly policy: CommandPolicyConfig = {},
	) {}

	register(tool: string, execute: ToolExecute): void {
		this.executes.set(tool, execute);
	}

	async handle(
		intent: Exclude<Intent, { kind: "ask" | "help" | "cancel" | "thread_status" }>,
		context: CallContext = {},
		signal?: AbortSignal,
	): Promise<Reply> {
		if (intent.kind === "bash") return this.bash(intent.channel, intent.actor, intent.cmd, context, signal);
		if (intent.kind === "approve") return this.handleApprove(intent, signal);
		if (intent.kind === "deny") return this.handleDeny(intent);
		return this.handleStatus(intent);
	}

	async bash(
		channel: string,
		actor: string,
		command: string,
		context: CallContext = {},
		signal?: AbortSignal,
	): Promise<Reply> {
		if (!this.runtime.bash) throw new Error(`runtime ${this.runtime.name} does not support bash`);
		const risk = classifyCommand(command, this.policy);
		this.log.debug("call.policy", {
			...context,
			channel,
			tool: "bash",
			runtime: this.runtime.name,
			risk: risk.risk,
			reason: risk.reason,
		});
		const base = {
			channel,
			actor,
			tool: "bash",
			command,
			args: { command },
			runtime: this.runtime.name,
			policyReason: risk.reason,
			context,
		};
		if (risk.risk === "block") return this.block(base, risk.reason);
		if (risk.risk === "approval") return this.requestApproval(base, risk.reason);
		const row = await this.createCall(base, "running");
		return this.executeBash(row.id, channel, command, context, signal);
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
		const base = {
			channel: input.channel,
			actor: input.actor,
			tool: input.name,
			args: input.args,
			policyReason: confirmation?.reason ?? "tool default",
			context: input.context,
		};
		if (confirmation) return this.requestApproval(base, confirmation.reason);
		const row = await this.createCall(base, "running");
		return this.executeTool(row.id, input.name, input.args, input.execute, input.context ?? {}, input.signal);
	}

	private async block(input: CallBase, reason: string): Promise<Reply> {
		const row = await this.createCall(input, "blocked");
		return renderCall({ callId: row.id, state: row.state, reason });
	}

	private async requestApproval(input: CallBase, reason: string): Promise<Reply> {
		const row = await this.createCall(input, "pending_approval");
		const approval = await this.approvals.create({
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
		});
	}

	private async createCall(input: CallBase, state: "running" | "pending_approval" | "blocked") {
		return await this.calls.create({
			turnId: input.context?.turn,
			threadId: input.context?.thread,
			messageId: input.context?.message,
			toolCallId: input.context?.toolCall,
			channel: input.channel,
			actor: input.actor,
			tool: input.tool,
			command: input.command,
			args: JSON.stringify(input.args),
			runtime: input.runtime,
			state,
			policyReason: input.policyReason,
		});
	}

	private async executeBash(
		callId: string,
		channel: string,
		command: string,
		context: CallContext,
		signal?: AbortSignal,
	): Promise<Reply> {
		this.log.info("call.start", { ...context, channel, call: callId, tool: "bash", runtime: this.runtime.name });
		let out: { result: { code: number; out: string; err: string; ms: number }; waitMs: number };
		try {
			out = await this.queue.submit(
				channel,
				() => this.runtime.bash?.({ command, signal }) ?? missingBash(this.runtime.name),
				signal,
			);
		} catch (error) {
			const err = error instanceof Error ? error.message : String(error);
			const result = { code: 130, out: "", err, ms: 0 };
			await this.calls.finish(callId, { state: "cancelled", ...result, queueWaitMs: 0 });
			this.log.info("call.end", { ...context, channel, call: callId, tool: "bash", state: "cancelled", code: 130 });
			return {
				...renderCall({ callId, state: "cancelled", ...result }),
				continuation: continuation(callId, "bash", context, "", err, true),
			};
		}
		const state = signal?.aborted ? "cancelled" : out.result.code === 0 ? "done" : "failed";
		assertTransition("running", state);
		await this.calls.finish(callId, { state, ...out.result, queueWaitMs: out.waitMs });
		this.log.info("call.end", {
			...context,
			channel,
			call: callId,
			tool: "bash",
			state,
			code: out.result.code,
			ms: out.result.ms,
			queueWaitMs: out.waitMs,
		});
		return {
			...renderCall({ callId, state, ...out.result }),
			continuation: continuation(callId, "bash", context, out.result.out, out.result.err, state !== "done"),
		};
	}

	private async executeTool(
		callId: string,
		tool: string,
		args: Record<string, unknown>,
		execute: ToolExecute,
		context: CallContext,
		signal?: AbortSignal,
	): Promise<Reply> {
		const start = Date.now();
		this.log.info("call.start", { ...context, call: callId, tool });
		try {
			const out = await execute(args, signal);
			const ms = Date.now() - start;
			await this.calls.finish(callId, {
				state: "done",
				code: 0,
				out: out.out,
				err: out.err ?? "",
				ms,
				queueWaitMs: 0,
			});
			this.log.info("call.end", { ...context, call: callId, tool, state: "done", code: 0, ms });
			return {
				...renderCall({ callId, state: "done", code: 0, out: out.out, err: out.err ?? "", ms }),
				continuation: continuation(callId, tool, context, out.out, out.err ?? "", false),
			};
		} catch (error) {
			const ms = Date.now() - start;
			const err = error instanceof Error ? error.message : String(error);
			const state = signal?.aborted || isAbortError(error) ? "cancelled" : "failed";
			const code = state === "cancelled" ? 130 : 1;
			await this.calls.finish(callId, { state, code, out: "", err, ms, queueWaitMs: 0 });
			this.log.info("call.end", { ...context, call: callId, tool, state, code, ms });
			return {
				...renderCall({ callId, state, code, out: "", err, ms }),
				continuation: continuation(callId, tool, context, "", err, true),
			};
		}
	}

	private async handleApprove(intent: Extract<Intent, { kind: "approve" }>, signal?: AbortSignal): Promise<Reply> {
		const approval = await this.approvals.getByChannel(intent.channel, intent.approvalId);
		if (!approval) return { text: "approval not found", private: true };
		if (approval.state !== "pending") {
			this.log.info("approval.already_resolved", {
				approval: approval.id,
				call: approval.callId,
				channel: approval.channel,
				actor: intent.actor,
				state: approval.state,
				resolvedBy: approval.resolvedBy ?? undefined,
			});
			return { text: `approval already ${approval.state} by ${approval.resolvedBy ?? "unknown"}`, private: true };
		}
		if (!this.canApprove(intent.actor)) {
			this.log.warn("approval.unauthorized", {
				approval: approval.id,
				call: approval.callId,
				channel: approval.channel,
				actor: intent.actor,
				requestedBy: approval.requestedBy ?? undefined,
			});
			return renderCall({ callId: approval.callId, state: "unauthorized", approvers: this.approvers() });
		}
		if (this.expired(approval.expiresAt)) {
			const resolved = await this.updateApprovalCall(approval.id, "denied", "heypi", approval.callId, "blocked");
			if (!resolved) {
				this.log.info("approval.already_resolved", {
					approval: approval.id,
					call: approval.callId,
					channel: approval.channel,
					actor: intent.actor,
					state: "resolved",
				});
				return { text: "approval already resolved", private: true };
			}
			this.log.info("approval.expired", {
				approval: approval.id,
				call: approval.callId,
				channel: approval.channel,
				actor: intent.actor,
				expiresAt: approval.expiresAt ?? undefined,
			});
			return { text: "approval expired", private: true };
		}
		const current = await this.calls.get(approval.callId);
		if (!current) throw new Error("call not found");
		assertTransition(parseCallState(current.state), "running");
		if (!(await this.updateApprovalCall(approval.id, "approved", intent.actor, approval.callId, "running"))) {
			this.log.info("approval.already_resolved", {
				approval: approval.id,
				call: approval.callId,
				channel: approval.channel,
				actor: intent.actor,
				state: "resolved",
			});
			return { text: "approval already resolved", private: true };
		}
		this.log.info("approval.approved", {
			approval: approval.id,
			call: approval.callId,
			channel: approval.channel,
			actor: intent.actor,
			tool: current.tool,
			thread: current.threadId ?? undefined,
			turn: current.turnId ?? undefined,
		});
		if (current.tool === "bash") {
			if (approval.runtime !== this.runtime.name) throw new Error(`approval runtime mismatch: ${approval.runtime}`);
			if (!current.command) throw new Error("approved bash call missing command");
			return this.executeBash(approval.callId, approval.channel, current.command, context(current), signal);
		}
		const execute = this.executes.get(current.tool);
		if (!execute) throw new Error(`approved tool not registered: ${current.tool}`);
		return this.executeTool(approval.callId, current.tool, args(current.args), execute, context(current), signal);
	}

	private async handleDeny(intent: Extract<Intent, { kind: "deny" }>): Promise<Reply> {
		const approval = await this.approvals.getByChannel(intent.channel, intent.approvalId);
		if (!approval) return { text: "approval not found", private: true };
		if (approval.state !== "pending") {
			this.log.info("approval.already_resolved", {
				approval: approval.id,
				call: approval.callId,
				channel: approval.channel,
				actor: intent.actor,
				state: approval.state,
				resolvedBy: approval.resolvedBy ?? undefined,
			});
			return { text: `approval already ${approval.state} by ${approval.resolvedBy ?? "unknown"}`, private: true };
		}
		if (!this.canApprove(intent.actor)) {
			this.log.warn("approval.unauthorized", {
				approval: approval.id,
				call: approval.callId,
				channel: approval.channel,
				actor: intent.actor,
				requestedBy: approval.requestedBy ?? undefined,
			});
			return renderCall({ callId: approval.callId, state: "unauthorized", approvers: this.approvers() });
		}
		const current = await this.calls.get(approval.callId);
		if (!current) throw new Error("call not found");
		assertTransition(parseCallState(current.state), "blocked");
		if (!(await this.updateApprovalCall(approval.id, "denied", intent.actor, approval.callId, "blocked"))) {
			this.log.info("approval.already_resolved", {
				approval: approval.id,
				call: approval.callId,
				channel: approval.channel,
				actor: intent.actor,
				state: "resolved",
			});
			return { text: "approval already resolved", private: true };
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
		return renderCall({ callId: approval.callId, state: "blocked", reason: "denied" });
	}

	private async updateApprovalCall(
		approvalId: string,
		approvalState: "approved" | "denied",
		actor: string,
		callId: string,
		callState: "running" | "blocked",
	): Promise<boolean> {
		if (!this.transaction) {
			const resolved = await this.approvals.resolve(approvalId, approvalState, actor);
			if (resolved) await this.calls.setState(callId, callState);
			return resolved;
		}
		return await this.transaction(async (store) => {
			const resolved = await store.approvals.resolve(approvalId, approvalState, actor);
			if (resolved) await store.calls.setState(callId, callState);
			return resolved;
		});
	}

	private canApprove(actor: string): boolean {
		const approvers = this.approval.approvers ?? [];
		return approvers.length === 0 || approvers.includes(actor);
	}

	private approvers(): string[] {
		return this.approval.approvers ?? [];
	}

	private expiresAt(): number | undefined {
		if (!this.approval.expiresInMs) return undefined;
		return Date.now() + this.approval.expiresInMs;
	}

	private expired(expiresAt: number | null): boolean {
		return typeof expiresAt === "number" && expiresAt <= Date.now();
	}

	private async handleStatus(intent: Extract<Intent, { kind: "status" }>): Promise<Reply> {
		const row = await this.calls.getByChannel(intent.channel, intent.callId);
		if (!row) return { text: "status: call not found" };
		return renderCall({
			callId: row.id,
			state: row.state,
			code: row.code ?? undefined,
			out: row.out ?? undefined,
			err: row.err ?? undefined,
			ms: row.ms ?? undefined,
		});
	}
}

function confirm(input: Confirm | undefined, args: Record<string, unknown>): { reason: string } | undefined {
	if (!input) return undefined;
	if (typeof input === "function") return input(args) || undefined;
	return input;
}

function args(input: string | null): Record<string, unknown> {
	if (!input) return {};
	const parsed = JSON.parse(input) as unknown;
	return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : {};
}

function context(call: {
	threadId: string | null;
	turnId: string | null;
	messageId: string | null;
	toolCallId: string | null;
}) {
	return {
		thread: call.threadId ?? undefined,
		turn: call.turnId ?? undefined,
		message: call.messageId ?? undefined,
		toolCall: call.toolCallId ?? undefined,
	};
}

function continuation(
	callId: string,
	tool: string,
	context: CallContext,
	out: string,
	err: string,
	isError: boolean,
): Reply["continuation"] {
	if (!context.thread || !context.toolCall) return undefined;
	return {
		threadId: context.thread,
		toolCallId: context.toolCall,
		tool,
		out: out || `call=${callId}`,
		err,
		isError,
	};
}

async function missingBash(name: string): Promise<never> {
	throw new Error(`runtime ${name} does not support bash`);
}
