import type { CreateAgentSessionOptions } from "@earendil-works/pi-coding-agent";

export type LogLevel = "debug" | "info" | "warn" | "error";

export type Logger = {
	debug(event: string, data?: Record<string, unknown>): void;
	info(event: string, data?: Record<string, unknown>): void;
	warn(event: string, data?: Record<string, unknown>): void;
	error(event: string, data?: Record<string, unknown>): void;
};

export type ModelConfig = CreateAgentSessionOptions["model"];

export type AdapterKind = "slack" | "discord" | "telegram" | "webhook";

export type ChatAttachment = {
	id?: string;
	name?: string;
	path?: string;
	url?: string;
	mime?: string;
};

export type ChatMessage = {
	id: string;
	adapter: AdapterKind | string;
	account: string;
	conversation: string;
	user: {
		id: string;
		name?: string;
		isBot?: boolean;
	};
	text: string;
	mentioned: boolean;
	dm: boolean;
	time?: string;
	attachments?: ChatAttachment[];
};

export type SendMessage = {
	conversation: string;
	thread?: string;
	text: string;
	attachments?: ChatAttachment[];
};

export type ApprovalState = "pending" | "approved" | "rejected";

export type ApprovalView = {
	conversation?: string;
	thread?: string;
	reason: string;
	requestedBy?: string;
	detailLabel?: string;
	detail?: string;
	command?: string;
	state?: ApprovalState;
	resolvedBy?: string;
	showId?: boolean;
	id?: string;
};

export type ApprovalDecision = {
	approved: boolean;
	resolvedBy?: string;
	reason?: string;
};

export type AdapterContext = {
	agentId: string;
	receive(message: ChatMessage): Promise<void>;
	logger: Logger;
};

export type Adapter = {
	kind: AdapterKind | string;
	name?: string;
	start(context: AdapterContext): Promise<void> | void;
	stop?(): Promise<void> | void;
	send(message: SendMessage): Promise<{ id?: string } | void>;
	requestApproval?(view: ApprovalView): Promise<ApprovalDecision>;
	ack?(message: ChatMessage): Promise<void> | void;
};

export type ContextRange = "current" | "delta" | "thread";

export type ContextConfig = {
	range?: ContextRange;
	includeSince?: "lastCompletedTrigger" | "threadStart";
	maxMessages?: number;
	maxChars?: number;
	includeBotMessages?: boolean;
	includeAttachments?: boolean;
};

export type ApprovalLayout = "message" | "card";

export type ApprovalConfig = {
	layout?: ApprovalLayout;
	tools?: string[];
};

export type StateConfig = {
	dir?: string;
};

export type LoadAgentOptions = {
	id?: string;
	model?: ModelConfig;
	adapters?: Adapter[];
	context?: ContextConfig;
	approvals?: ApprovalConfig;
	state?: StateConfig;
	tools?: string[];
	excludeTools?: string[];
	noTools?: CreateAgentSessionOptions["noTools"];
};

export type AgentFileConfig = Pick<
	LoadAgentOptions,
	"id" | "context" | "approvals" | "state" | "tools" | "excludeTools" | "noTools"
>;

export type AgentResource = {
	path: string;
	name: string;
	kind: "instruction" | "system" | "config" | "skill" | "tool" | "extension";
};

export type AgentConfig = LoadAgentOptions & {
	id: string;
	root: string;
	instructions?: string;
	system?: string;
	resources: AgentResource[];
};
