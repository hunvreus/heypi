import type { ApprovalPolicy, ModelConfig } from "../config.js";
import type { TurnScope } from "../core/scope.js";
import type { Reply, ToolContinuation } from "../core/types.js";
import type { Attachment } from "../io/attachments.js";
import type { ReplyStream } from "../io/reply-stream.js";
import type { RuntimeEventHandler } from "./types.js";

type AgentLiveSession = {
	steer(text: string, attachments?: Attachment[]): Promise<void>;
	followUp(text: string, attachments?: Attachment[]): Promise<void>;
};

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
	actorGroups?: string[];
	trace?: string;
	text: string;
	model?: ModelConfig;
	scope?: TurnScope;
	attachments?: Attachment[];
	signal?: AbortSignal;
	stream?: ReplyStream;
	runtimeEvents?: RuntimeEventHandler;
	approval?: ApprovalPolicy;
	onLiveSession?: (session: AgentLiveSession | undefined) => void;
};

export type AgentRes = Reply;

export interface Agent {
	ask(req: AgentReq): Promise<AgentRes>;
	continue(req: Omit<AgentReq, "text" | "inputMessageId"> & { continuation?: ToolContinuation }): Promise<AgentRes>;
}
