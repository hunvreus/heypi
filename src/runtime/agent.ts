import type { ModelConfig } from "../config.js";
import type { Reply } from "../core/types.js";
import type { StoredMessage } from "../store/types.js";

export type AgentReq = {
	threadId: string;
	inputMessageId?: string;
	turnId?: string;
	channel: string;
	actor: string;
	trace?: string;
	text: string;
	model?: ModelConfig;
	signal?: AbortSignal;
};

export type AgentRes = Reply & { messages?: StoredMessage[] };

export interface Agent {
	ask(req: AgentReq): Promise<AgentRes>;
	continue(req: Omit<AgentReq, "text" | "inputMessageId">): Promise<AgentRes>;
}
