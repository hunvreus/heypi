import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import { type Static, Type } from "@sinclair/typebox";

const chatReplyParameters = Type.Object({
	text: Type.String({ description: "Short message to send to the current chat thread" }),
});

type ChatReplyParams = Static<typeof chatReplyParameters>;

export type ChatReplySender = (text: string) => Promise<void>;

export function createChatReplyTool(send: ChatReplySender): ToolDefinition<typeof chatReplyParameters> {
	return {
		name: "chat_reply",
		label: "Chat Reply",
		description: "Send a short progress or acknowledgement message to the current chat thread.",
		promptSnippet: "Send a short progress or acknowledgement message to the current chat thread.",
		promptGuidelines: [
			"Use chat_reply sparingly for long-running work when the user would otherwise have no useful update.",
			"Do not use chat_reply for the final answer; just answer normally at the end.",
		],
		parameters: chatReplyParameters,
		async execute(_toolCallId, params, signal) {
			signal?.throwIfAborted?.();
			const text = (params as ChatReplyParams).text.trim();
			if (!text) return { content: [{ type: "text", text: "No message sent." }], details: { sent: false } };
			await send(text);
			return { content: [{ type: "text", text: "Message sent." }], details: { sent: true } };
		},
	};
}
