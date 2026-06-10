import { isRuntimeStartupError, RUNTIME_STARTUP_ERROR_KIND } from "../runtime/errors.js";
import type { Queue } from "../runtime/queue.js";
import type { Runtime } from "../runtime/types.js";
import type { Calls } from "../store/types.js";
import { isAbortError } from "./active.js";
import { continuation } from "./call-reply.js";
import { renderCall } from "./format.js";
import type { Logger } from "./log.js";
import type { AppMessages } from "./messages.js";
import { assertTransition } from "./state.js";
import type { Reply, ToolExecute } from "./types.js";

type ExecContext = {
	runtimeScope?: string;
	thread?: string;
	toolCall?: string;
};

export async function executeBashCall(input: {
	callId: string;
	channel: string;
	actor: string | null | undefined;
	command: string;
	context: ExecContext;
	signal?: AbortSignal;
	queue: Queue;
	runtime: Runtime;
	calls: Calls;
	log: Logger;
	messages: AppMessages;
}): Promise<Reply> {
	const { callId, channel, actor, command, context, signal, queue, runtime, calls, log, messages } = input;
	log.info("call.start", { ...context, channel, call: callId, tool: "bash", runtime: runtime.name });
	let out: { result: { code: number; out: string; err: string; ms: number }; waitMs: number };
	try {
		out = await queue.submit(channel, () => runtime.bash?.({ command, signal }) ?? missingBash(runtime.name), signal);
	} catch (error) {
		const err = error instanceof Error ? error.message : String(error);
		const state = signal?.aborted || isAbortError(error) ? "cancelled" : "failed";
		const result = { code: state === "cancelled" ? 130 : 1, out: "", err, ms: 0 };
		const runtimeFailed = isRuntimeStartupError(error);
		const visibleErr = runtimeFailed ? messages.runtimeFailed : err;
		await calls.finish(callId, {
			state,
			...result,
			errKind: runtimeFailed ? RUNTIME_STARTUP_ERROR_KIND : undefined,
			queueWaitMs: 0,
		});
		log.info("call.end", { ...context, channel, call: callId, tool: "bash", state, code: result.code });
		return {
			...renderCall({ callId, state, ...result, messages, runtimeFailed }),
			continuation: continuation(callId, "bash", context, actor, "", visibleErr, true),
		};
	}
	const state = signal?.aborted ? "cancelled" : out.result.code === 0 ? "done" : "failed";
	assertTransition("running", state);
	await calls.finish(callId, { state, ...out.result, queueWaitMs: out.waitMs });
	log.info("call.end", {
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
		continuation: continuation(callId, "bash", context, actor, out.result.out, out.result.err, state !== "done"),
	};
}

export async function executeToolCall(input: {
	callId: string;
	tool: string;
	actor: string | null | undefined;
	args: Record<string, unknown>;
	execute: ToolExecute;
	context: ExecContext;
	signal?: AbortSignal;
	runtime: Runtime;
	calls: Calls;
	log: Logger;
	messages: AppMessages;
}): Promise<Reply> {
	const { callId, tool, actor, args, execute, context, signal, runtime, calls, log, messages } = input;
	const start = Date.now();
	log.info("call.start", { ...context, call: callId, tool });
	try {
		const out = await execute(args, { runtime, runtimeScope: context.runtimeScope, signal });
		const ms = Date.now() - start;
		await calls.finish(callId, {
			state: "done",
			code: 0,
			out: out.out,
			err: out.err ?? "",
			ms,
			queueWaitMs: 0,
		});
		log.info("call.end", { ...context, call: callId, tool, state: "done", code: 0, ms });
		return {
			...renderCall({ callId, state: "done", code: 0, out: out.out, err: out.err ?? "", ms }),
			continuation: continuation(callId, tool, context, actor, out.out, out.err ?? "", false),
		};
	} catch (error) {
		const ms = Date.now() - start;
		const err = error instanceof Error ? error.message : String(error);
		const state = signal?.aborted || isAbortError(error) ? "cancelled" : "failed";
		const code = state === "cancelled" ? 130 : 1;
		const runtimeFailed = isRuntimeStartupError(error);
		const visibleErr = runtimeFailed ? messages.runtimeFailed : err;
		await calls.finish(callId, {
			state,
			code,
			out: "",
			err,
			errKind: runtimeFailed ? RUNTIME_STARTUP_ERROR_KIND : undefined,
			ms,
			queueWaitMs: 0,
		});
		log.info("call.end", { ...context, call: callId, tool, state, code, ms });
		return {
			...renderCall({ callId, state, code, out: "", err, ms, messages, runtimeFailed }),
			continuation: continuation(callId, tool, context, actor, "", visibleErr, true),
		};
	}
}

async function missingBash(name: string): Promise<never> {
	throw new Error(`runtime ${name} does not support bash`);
}
