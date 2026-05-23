import type { ModelConfig } from "../config.js";
import type { Reply, ToolContinuation } from "../core/types.js";
import type { Attachment } from "../io/attachments.js";
import type { ReplyStream } from "../io/reply-stream.js";

export type AgentReq = {
	threadId: string;
	sessionId: string;
	sessionPath: string;
	inputMessageId?: string;
	turnId?: string;
	provider: string;
	channel: string;
	channelName?: string;
	thread?: string;
	threadName?: string;
	actor: string;
	actorName?: string;
	trace?: string;
	text: string;
	model?: ModelConfig;
	attachments?: Attachment[];
	signal?: AbortSignal;
	stream?: ReplyStream;
};

export type AgentRes = Reply;

export interface Agent {
	ask(req: AgentReq): Promise<AgentRes>;
	continue(req: Omit<AgentReq, "text" | "inputMessageId"> & { continuation?: ToolContinuation }): Promise<AgentRes>;
}
