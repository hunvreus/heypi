import type { CreateAgentSessionOptions, ToolDefinition } from "@earendil-works/pi-coding-agent";
import type { AdapterEvents } from "./events.js";
import type { RetryConfig } from "./retry.js";

export type ModelConfig = CreateAgentSessionOptions["model"];

export type Logger = {
	debug(event: string, data?: Record<string, unknown>): void;
	info(event: string, data?: Record<string, unknown>): void;
	warn(event: string, data?: Record<string, unknown>): void;
	error(event: string, data?: Record<string, unknown>): void;
	ready?(info: ReadyInfo): void;
};

export type ReadyInfo = {
	agent: string;
	adapters: string[];
	admin?: string;
};

export type AdapterKind = "slack" | "discord" | "telegram" | "webhook" | "local";

export type ChatAttachment = {
	id?: string;
	name?: string;
	path?: string;
	localPath?: string;
	url?: string;
	mime?: string;
};

export type AttachmentPolicy = {
	maxBytes?: number;
	timeoutMs?: number;
	mimeTypes?: string[];
	hosts?: string[];
	retry?: RetryConfig | false;
};

export type ChatMessage = {
	id: string;
	adapter: AdapterKind | string;
	adapterId: string;
	conversation: string;
	channel?: string;
	session?: string;
	thread?: string;
	replyTo?: string;
	user: {
		id: string;
		name?: string;
		groups?: string[];
		isBot?: boolean;
		isSelf?: boolean;
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
	replyTo?: string;
	text: string;
	attachments?: ChatAttachment[];
};

export type UpdateMessage = {
	conversation: string;
	thread?: string;
	id: string;
	text: string;
	attachments?: ChatAttachment[];
};

export type SentMessage = {
	id?: string;
	ids?: string[];
};

export type BusyMode = "queue" | "steer" | "reject";

export type AdapterContext = {
	agentId: string;
	logger: Logger;
	/** Persist and queue a message without waiting for its model turn to finish. */
	enqueue?(message: ChatMessage): Promise<void>;
	receive(message: ChatMessage): Promise<void>;
};

export type MaterializeContext = {
	dir: string;
	displayDir: string;
};

export type Adapter = {
	kind: AdapterKind | string;
	id?: string;
	allow?: AllowConfig;
	admins?: ApproverSet;
	approvers?: ApproverSet;
	approvals?: AdapterApprovalConfig;
	busy?: BusyMode;
	events?: AdapterEvents;
	start(context: AdapterContext): Promise<void> | void;
	stop?(): Promise<void> | void;
	send(message: SendMessage): Promise<SentMessage | undefined>;
	update?(message: UpdateMessage): Promise<void>;
	materializeAttachments?(message: ChatMessage, context: MaterializeContext): Promise<ChatMessage>;
	requestApproval?(view: ApprovalView, signal?: AbortSignal): Promise<ApprovalDecision>;
};

export type AllowConfig = {
	dms?: boolean;
	channels?: string[];
	users?: string[];
	groups?: string[];
	bots?: true | string[];
};

export type ApprovalLayout = "message" | "card";

export type ApproverSet = {
	users?: string[];
	groups?: string[];
	roles?: string[];
};

export type AdapterApprovalConfig = {
	layout?: ApprovalLayout;
	showId?: boolean;
	timeoutMs?: number;
};

export type ToolConfig = {
	approve?: ApprovalPolicy | false;
};

export type ToolEntry = false | ToolDefinition | ToolConfig;

export type ToolConfigMap = Record<string, ToolEntry | undefined>;

export type ApprovalContext = {
	toolName: string;
	input: unknown;
	adapter?: AdapterKind | string;
	adapterId?: string;
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
	layout?: ApprovalLayout;
	conversation?: string;
	thread?: string;
	replyTo?: string;
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
	messageIds?: string[];
	resolvedById?: string;
	resolvedBy?: string;
	roles?: string[];
	groups?: string[];
	reason?: string;
};

export type StateConfig = {
	dir?: string;
};

export type RuntimeKind = "host" | "docker" | "gondolin" | "just-bash" | "vercel" | "cloudflare";

export type RuntimeContext = {
	workspace: string;
	shared?: string;
	env?: Record<string, string>;
};

export type RuntimeInstance = {
	tools: ToolDefinition<any, any, any>[];
	/** Refresh external runtime state before a new user turn. */
	prepare?(): Promise<void>;
	cleanup(): Promise<void>;
};

export type RuntimeProvider = (context: RuntimeContext) => Promise<RuntimeInstance>;

export type RuntimeConfig = {
	kind?: RuntimeKind;
	workspace?: string;
	provider?: RuntimeProvider;
	/**
	 * Environment variables visible to code executed by the runtime.
	 *
	 * Values here are not secret-safe: a model-driven command can print them.
	 * Keep credentials in trusted tools/connections or runtime-specific brokers
	 * unless explicit runtime exposure is acceptable.
	 */
	env?: Record<string, string>;
};

export type AdminConfig = {
	host?: string;
	port?: number;
	path?: string;
	token?: string;
};

export type LoadAgentOptions = {
	id?: string;
	model?: ModelConfig;
	runtime?: RuntimeConfig;
	admin?: false | AdminConfig;
	state?: StateConfig;
	tools?: ToolConfigMap;
	todo?: boolean;
	memory?: boolean;
	noTools?: CreateAgentSessionOptions["noTools"];
};

export type AgentConfig = LoadAgentOptions & {
	id: string;
	root: string;
	instructions?: string;
	system?: string;
};
