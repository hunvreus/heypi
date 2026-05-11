import type { SessionMessageEntry } from "@mariozechner/pi-coding-agent";
import type { CallState, TurnState } from "../core/types.js";

export type StoredMessage = SessionMessageEntry["message"];

export type Thread = {
	id: string;
	agent: string;
	provider: string;
	channel: string;
	actor: string | null;
	key: string;
	createdAt: number;
	updatedAt: number;
};

export type Message = {
	id: string;
	threadId: string;
	provider: string;
	providerEventId: string | null;
	role: string;
	actor: string | null;
	text: string;
	data: string | null;
	state: string;
	createdAt: number;
	updatedAt: number;
};

export type HistoryMessage = Pick<Message, "id" | "role" | "actor" | "text" | "createdAt">;

export type Turn = {
	id: string;
	threadId: string;
	inputMessageId: string;
	resultMessageId: string | null;
	agent: string;
	provider: string;
	channel: string;
	actor: string | null;
	trace: string | null;
	state: string;
	createdAt: number;
	updatedAt: number;
};

export type Call = {
	id: string;
	turnId: string | null;
	threadId: string | null;
	messageId: string | null;
	channel: string;
	actor: string | null;
	tool: string;
	toolCallId: string | null;
	command: string | null;
	args: string | null;
	runtime: string | null;
	policyReason: string | null;
	state: string;
	code: number | null;
	out: string | null;
	err: string | null;
	ms: number | null;
	queueWaitMs: number | null;
	createdAt: number;
	updatedAt: number;
};

export type Approval = {
	id: string;
	callId: string;
	channel: string;
	threadId: string | null;
	turnId: string | null;
	requestMessageId: string | null;
	command: string;
	runtime: string;
	reason: string;
	state: string;
	requestedBy: string | null;
	requestedAt: number;
	expiresAt: number | null;
	resolvedAt: number | null;
	resolvedBy: string | null;
};

export type Lock = {
	key: string;
	owner: string;
	expiresAt: number;
	createdAt: number;
	updatedAt: number;
};

/** Thread identity store. Creates stable provider/thread mappings for later session replay. */
export interface Threads {
	getOrCreate(input: {
		agent: string;
		provider: string;
		channel: string;
		actor?: string;
		key: string;
	}): Promise<Thread>;
}

/** Message transcript store. Provides append-once semantics for provider retry dedupe. */
export interface Messages {
	create(input: {
		threadId: string;
		provider: string;
		providerEventId?: string;
		role: string;
		actor?: string;
		text: string;
		data?: string;
		state?: string;
		createdAt?: number;
	}): Promise<Message>;
	createOnce(input: {
		threadId: string;
		provider: string;
		providerEventId?: string;
		role: string;
		actor?: string;
		text: string;
		data?: string;
		state?: string;
		createdAt?: number;
	}): Promise<{ row: Message; inserted: boolean }>;
	listForThread(threadId: string, input?: { limit?: number; excludeId?: string }): Promise<Message[]>;
	search(input: {
		threadId: string;
		query?: string;
		limit?: number;
		before?: number;
		includeTools?: boolean;
	}): Promise<HistoryMessage[]>;
	getToolResult(threadId: string, toolCallId: string): Promise<Message | undefined>;
	update(id: string, input: { text: string; data?: string; state?: string; createdAt?: number }): Promise<void>;
}

/** Session view over stored messages. Returns Pi-compatible history for one agent turn. */
export interface Sessions {
	load(threadId: string, inputMessageId?: string): Promise<StoredMessage[]>;
}

/** Agent turn store. One turn is one provider input processed by the agent/core. */
export interface Turns {
	create(input: {
		threadId: string;
		inputMessageId: string;
		agent: string;
		provider: string;
		channel: string;
		actor?: string;
		trace?: string;
		state?: TurnState;
	}): Promise<Turn>;
	listForThread(threadId: string, input?: { limit?: number }): Promise<Turn[]>;
	finish(id: string, input: { state: TurnState; resultMessageId?: string }): Promise<void>;
}

/** Tool call store. Persists lifecycle state and output for bash and later custom tools. */
export interface Calls {
	create(input: {
		turnId?: string;
		threadId?: string;
		messageId?: string;
		channel: string;
		actor?: string;
		tool: string;
		toolCallId?: string;
		command?: string;
		args?: string;
		runtime?: string;
		state: CallState;
		policyReason?: string;
	}): Promise<Call>;
	get(id: string): Promise<Call | undefined>;
	getByChannel(channel: string, id: string): Promise<Call | undefined>;
	listForThread(threadId: string, input?: { states?: CallState[]; limit?: number }): Promise<Call[]>;
	setState(id: string, state: CallState): Promise<void>;
	finish(
		id: string,
		input: { state: CallState; code: number; out: string; err: string; ms: number; queueWaitMs: number },
	): Promise<void>;
}

/** Approval store for calls that require human confirmation before execution. */
export interface Approvals {
	create(input: {
		callId: string;
		channel: string;
		threadId?: string;
		turnId?: string;
		requestMessageId?: string;
		requestedBy?: string;
		expiresAt?: number;
		command: string;
		runtime: string;
		reason: string;
	}): Promise<Approval>;
	get(id: string): Promise<Approval | undefined>;
	getByChannel(channel: string, id: string): Promise<Approval | undefined>;
	getPending(channel: string, id: string): Promise<Approval | undefined>;
	listPending(input?: { threadId?: string; limit?: number }): Promise<Approval[]>;
	resolve(id: string, state: "approved" | "denied", actor: string): Promise<void>;
}

/** Durable concurrency guard for logical conversation processing across processes. */
export interface Locks {
	acquire(input: { key: string; owner: string; ttlMs?: number }): Promise<Lock | undefined>;
	get(key: string): Promise<Lock | undefined>;
	release(input: { key: string; owner: string }): Promise<void>;
}

/** Complete persistence boundary used by heypi core. Implementations may use SQLite, libSQL, or other stores. */
export interface Store {
	threads: Threads;
	messages: Messages;
	sessions: Sessions;
	turns: Turns;
	calls: Calls;
	approvals: Approvals;
	locks?: Locks;
	setup(): Promise<void>;
}
