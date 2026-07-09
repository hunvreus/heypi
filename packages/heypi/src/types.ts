import type { CreateAgentSessionOptions, ToolDefinition } from "@earendil-works/pi-coding-agent";
import type { AdapterEvents } from "./events.js";

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
	url?: string;
	mime?: string;
};

export type ChatMessage = {
	id: string;
	adapter: AdapterKind | string;
	account: string;
	conversation: string;
	thread?: string;
	user: {
		id: string;
		name?: string;
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

export type AdapterContext = {
	agentId: string;
	logger: Logger;
	receive(message: ChatMessage): Promise<void>;
};

export type Adapter = {
	kind: AdapterKind | string;
	name?: string;
	allow?: AllowConfig;
	admins?: ApproverSet;
	approvers?: ApproverSet;
	approvals?: AdapterApprovalConfig;
	progress?: boolean;
	events?: AdapterEvents;
	start(context: AdapterContext): Promise<void> | void;
	stop?(): Promise<void> | void;
	send(message: SendMessage): Promise<{ id?: string } | undefined>;
	update?(message: UpdateMessage): Promise<void>;
	ack?(message: ChatMessage): Promise<void> | void;
	requestApproval?(view: ApprovalView): Promise<ApprovalDecision>;
};

export type AllowConfig = {
	adapters?: string[];
	accounts?: string[];
	conversations?: string[];
	users?: string[];
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
			approvers?: ApproverSet;
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
	resolvedById?: string;
	resolvedBy?: string;
	roles?: string[];
	groups?: string[];
	reason?: string;
};

export type StateConfig = {
	dir?: string;
};

export type RuntimeKind = "host" | "docker";

export type RuntimeConfig = {
	kind?: RuntimeKind;
	workspace?: string;
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
};

export type LoadAgentOptions = {
	id?: string;
	model?: ModelConfig;
	runtime?: RuntimeConfig;
	admin?: false | AdminConfig;
	state?: StateConfig;
	tools?: ToolConfigMap;
	todo?: boolean;
	noTools?: CreateAgentSessionOptions["noTools"];
};

export type AgentConfig = LoadAgentOptions & {
	id: string;
	root: string;
	instructions?: string;
	system?: string;
};
