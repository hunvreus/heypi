import type { TurnScope } from "../core/scope.js";
import type { Reply, ToolContinuation } from "../core/types.js";
import type { ReplyStream } from "../io/reply-stream.js";
import type { Agent, AgentRes } from "../runtime/agent.js";
import type { RuntimeEventHandler } from "../runtime/types.js";
import type { Message, Store } from "./types.js";

export type ContinueInput = {
	store: Store;
	agent: Agent;
	provider: string;
	channel: string;
	actor: string;
	trace: string;
	turn: string;
	continuation: ToolContinuation;
	scope?: TurnScope;
	stream?: ReplyStream;
	runtimeEvents?: RuntimeEventHandler;
};

export type SaveInput = {
	store: Store;
	threadId: string;
	provider: string;
	kind?: string;
	reply: Reply;
};

/** Appends the approved tool result to the Pi session and continues the agent loop. */
export async function continueTool(input: ContinueInput): Promise<AgentRes> {
	const thread = await input.store.threads.get(input.continuation.threadId);
	if (!thread) throw new Error(`thread not found: ${input.continuation.threadId}`);
	return await input.agent.continue({
		threadId: thread.id,
		sessionId: thread.sessionId,
		sessionPath: thread.sessionPath,
		turnId: input.turn,
		provider: input.provider,
		channel: input.channel,
		actor: input.continuation.actor ?? input.actor,
		trace: input.trace,
		scope: input.scope,
		stream: input.stream,
		runtimeEvents: input.runtimeEvents,
		continuation: input.continuation,
	});
}

/** Persists a single audit row for the visible reply. Pi owns the protocol transcript. */
export async function saveReply(input: SaveInput): Promise<Message> {
	return await input.store.messages.create({
		threadId: input.threadId,
		provider: input.provider,
		kind: input.kind ?? input.provider,
		role: "assistant",
		actor: "heypi",
		text: input.reply.text,
		data: input.reply.attachments?.length ? JSON.stringify({ attachments: input.reply.attachments }) : undefined,
		state: "done",
	});
}
