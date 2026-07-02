import type { CreateAgentSessionOptions } from "@earendil-works/pi-coding-agent";

export type ModelConfig = CreateAgentSessionOptions["model"];

export type Logger = {
	debug(event: string, data?: Record<string, unknown>): void;
	info(event: string, data?: Record<string, unknown>): void;
	warn(event: string, data?: Record<string, unknown>): void;
	error(event: string, data?: Record<string, unknown>): void;
};

export type AdapterKind = "slack" | "discord" | "telegram" | "webhook" | "local";

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

export type AdapterContext = {
	agentId: string;
	logger: Logger;
	receive(message: ChatMessage): Promise<void>;
};

export type Adapter = {
	kind: AdapterKind | string;
	name?: string;
	start(context: AdapterContext): Promise<void> | void;
	stop?(): Promise<void> | void;
	send(message: SendMessage): Promise<{ id?: string } | undefined>;
	ack?(message: ChatMessage): Promise<void> | void;
	requestApproval?(view: ApprovalView): Promise<ApprovalDecision>;
};

export type ContextMode = "current" | "delta";

export type ContextConfig = {
	mode?: ContextMode;
	maxMessages?: number;
	maxChars?: number;
	includeBotMessages?: boolean;
	includeAttachments?: boolean;
};

export type ApprovalLayout = "message" | "card";

export type ApprovalConfig = {
	layout?: ApprovalLayout;
	tools?: string[];
	policy?: ApprovalPolicy;
	showId?: boolean;
};

export type ApprovalContext = {
	toolName: string;
	input: unknown;
	adapter?: AdapterKind | string;
	account?: string;
	conversation?: string;
	thread?: string;
	actor?: {
		id: string;
		name?: string;
	};
	approvedTools: ReadonlySet<string>;
};

export type ApprovalPolicyResult =
	| false
	| {
			type: "approve";
			reason: string;
			detailLabel?: string;
			detail?: string;
			command?: string;
	  }
	| {
			type: "block";
			reason: string;
	  };

export type ApprovalPolicy = (context: ApprovalContext) => ApprovalPolicyResult | Promise<ApprovalPolicyResult>;

export type ApprovalState = "pending" | "approved" | "rejected";

export type ApprovalView = {
	id: string;
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
};

export type ApprovalDecision = {
	approved: boolean;
	resolvedBy?: string;
	reason?: string;
};

export type StateConfig = {
	dir?: string;
};

export type AgentFileConfig = {
	id?: string;
	context?: ContextConfig;
	approvals?: ApprovalConfig;
	state?: StateConfig;
	tools?: string[];
	excludeTools?: string[];
	noTools?: CreateAgentSessionOptions["noTools"];
};

export type LoadAgentOptions = AgentFileConfig & {
	model?: ModelConfig;
	adapters?: Adapter[];
};

export type AgentConfig = LoadAgentOptions & {
	id: string;
	root: string;
	instructions?: string;
	system?: string;
};
