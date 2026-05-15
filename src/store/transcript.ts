import { textContent } from "../core/content.js";
import type { Reply, ToolContinuation } from "../core/types.js";
import type { ReplyStream } from "../io/reply-stream.js";
import type { Agent, AgentRes } from "../runtime/agent.js";
import type { Message, Store, StoredMessage } from "./types.js";

export type ContinueInput = {
	store: Store;
	agent: Agent;
	provider: string;
	channel: string;
	actor: string;
	trace: string;
	turn: string;
	continuation: ToolContinuation;
	stream?: ReplyStream;
};

export type SaveInput = {
	store: Store;
	threadId: string;
	provider: string;
	reply: Reply & { messages?: StoredMessage[] };
};

/** Replaces a pending approval tool result and continues the Pi loop from stored history. */
export async function continueTool(input: ContinueInput): Promise<AgentRes> {
	const message = toolResult(input.continuation);
	const existing = await input.store.messages.getToolResult(
		input.continuation.threadId,
		input.continuation.toolCallId,
	);
	if (!existing) throw new Error(`tool result not found: ${input.continuation.toolCallId}`);
	await input.store.messages.update(existing.id, {
		text: messageText(message),
		data: encode(message, { trace: input.trace }),
		state: "done",
		createdAt: Date.now() + 1,
	});
	return await input.agent.continue({
		threadId: input.continuation.threadId,
		turnId: input.turn,
		channel: input.channel,
		actor: input.actor,
		trace: input.trace,
		stream: input.stream,
	});
}

/** Persists generated Pi messages, falling back to plain assistant text for non-Pi replies. */
export async function saveReply(input: SaveInput): Promise<Message> {
	const messages = input.reply.messages?.filter((message) => message.role !== "user") ?? [];
	if (messages.length === 0) {
		return await input.store.messages.create({
			threadId: input.threadId,
			provider: input.provider,
			role: "assistant",
			actor: "heypi",
			text: input.reply.text,
			data: input.reply.attachments?.length ? JSON.stringify({ attachments: input.reply.attachments }) : undefined,
			state: "done",
		});
	}

	let last: Message | undefined;
	const start = Date.now();
	for (let i = 0; i < messages.length; i++) {
		const message = messages[i];
		last = await input.store.messages.create({
			threadId: input.threadId,
			provider: input.provider,
			role: message.role,
			actor: "heypi",
			toolCallId: toolCallId(message),
			text: messageText(message),
			data: encode(message),
			state: "done",
			createdAt: start + i,
		});
	}
	if (!last) throw new Error("reply persistence failed");
	return last;
}

export function encode(message: StoredMessage, extra: Record<string, unknown> = {}): string {
	return JSON.stringify({ ...extra, pi: message });
}

export function decode(data: string | null): StoredMessage | undefined {
	if (!data) return undefined;
	try {
		const parsed = JSON.parse(data) as unknown;
		if (!parsed || typeof parsed !== "object" || !("pi" in parsed)) return undefined;
		const pi = (parsed as { pi?: unknown }).pi;
		return pi && typeof pi === "object" && "role" in pi ? (pi as StoredMessage) : undefined;
	} catch {
		return undefined;
	}
}

export function messageText(message: StoredMessage): string {
	if (!("content" in message)) return "";
	return textContent(message.content);
}

function toolResult(input: ToolContinuation): StoredMessage {
	return {
		role: "toolResult",
		toolCallId: input.toolCallId,
		toolName: input.tool,
		content: [{ type: "text", text: input.isError ? input.err : input.out }],
		details: { state: input.isError ? "failed" : "done" },
		isError: input.isError,
		timestamp: Date.now(),
	} as StoredMessage;
}

function toolCallId(message: StoredMessage): string | undefined {
	if (!("toolCallId" in message)) return undefined;
	return typeof message.toolCallId === "string" ? message.toolCallId : undefined;
}
