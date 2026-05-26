import type { SessionMessageEntry } from "@earendil-works/pi-coding-agent";
import type { CallState, TurnState } from "../core/types.js";

export type StoredMessage = SessionMessageEntry["message"];

export type Thread = {
	id: string;
	agent: string;
	provider: string;
	kind: string;
	team: string | null;
	channel: string;
	actor: string | null;
	key: string;
	sessionId: string;
	sessionPath: string;
	createdAt: number;
	updatedAt: number;
};

export type Message = {
	id: string;
	threadId: string;
	provider: string;
	kind: string;
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
	kind: string;
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
	details: string | null;
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

export type JobState = "active" | "paused";
export type JobRunState = "running" | "done" | "failed" | "skipped";
export type DeliveryState = "pending" | "delivered" | "failed" | "none";

export type Job = {
	id: string;
	agent: string;
	kind: string;
	schedule: string;
	scope: string | null;
	target: string | null;
	prompt: string;
	state: string;
	nextAt: number | null;
	lastAt: number | null;
	idleMs: number | null;
	createdAt: number;
	updatedAt: number;
};

export type JobRun = {
	id: string;
	jobAgent: string;
	jobId: string;
	threadId: string | null;
	trace: string;
	state: string;
	output: string | null;
	error: string | null;
	deliveryState: string;
	startedAt: number;
	endedAt: number | null;
};

/** Thread identity store. Creates stable provider/thread mappings to Pi session files. */
export interface Threads {
	getOrCreate(input: {
		agent: string;
		provider: string;
		kind?: string;
		team?: string;
		channel: string;
		actor?: string;
		key: string;
	}): Promise<Thread>;
	get(id: string): Promise<Thread | undefined>;
	getByKey(agent: string, provider: string, team: string | undefined, key: string): Promise<Thread | undefined>;
	list(input?: {
		agent?: string;
		providers?: string[];
		teams?: string[];
		channels?: string[];
		users?: string[];
		limit?: number;
		offset?: number;
	}): Promise<Thread[]>;
}

/** Message transcript store. Provides append-once semantics for provider retry dedupe. */
export interface Messages {
	get(id: string): Promise<Message | undefined>;
	create(input: {
		threadId: string;
		provider: string;
		kind?: string;
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
		kind?: string;
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
	update(id: string, input: { text: string; data?: string; state?: string; createdAt?: number }): Promise<void>;
}

/** Agent turn store. One turn is one provider input processed by the agent/core. */
export interface Turns {
	create(input: {
		threadId: string;
		inputMessageId: string;
		agent: string;
		provider: string;
		kind?: string;
		channel: string;
		actor?: string;
		trace?: string;
		state?: TurnState;
	}): Promise<Turn>;
	getByTrace(threadId: string, trace: string): Promise<Turn | undefined>;
	listForThread(threadId: string, input?: { limit?: number }): Promise<Turn[]>;
	listRunning?(input?: { agent?: string; limit?: number }): Promise<Turn[]>;
	listRecent?(input?: { agent?: string; states?: TurnState[]; limit?: number; offset?: number }): Promise<Turn[]>;
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
	listRecent?(input?: { states?: CallState[]; limit?: number; offset?: number }): Promise<Call[]>;
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
		details?: string;
	}): Promise<Approval>;
	get(id: string): Promise<Approval | undefined>;
	getByChannel(channel: string, id: string): Promise<Approval | undefined>;
	getPending(channel: string, id: string): Promise<Approval | undefined>;
	listPending(input?: { threadId?: string; turnId?: string; limit?: number; offset?: number }): Promise<Approval[]>;
	resolve(id: string, state: "approved" | "denied", actor: string): Promise<boolean>;
}

/** Durable concurrency guard for logical conversation processing across processes. */
export interface Locks {
	acquire(input: { key: string; owner: string; ttlMs?: number }): Promise<Lock | undefined>;
	get(key: string): Promise<Lock | undefined>;
	refresh(input: { key: string; owner: string; ttlMs?: number }): Promise<Lock | undefined>;
	release(input: { key: string; owner: string }): Promise<void>;
	clear?(input?: { prefix?: string }): Promise<number>;
}

export type SchedulerStore = Store & {
	jobs: Jobs;
	jobRuns: JobRuns;
	locks: Locks;
};

/** Scheduled and heartbeat job store. Jobs create synthetic chat turns when due. */
export interface Jobs {
	upsert(input: {
		id: string;
		agent: string;
		kind: string;
		schedule: string;
		scope?: string | null;
		target?: string | null;
		prompt: string;
		state?: JobState;
		nextAt?: number | null;
		idleMs?: number | null;
	}): Promise<Job>;
	due(input: { agent: string; now: number; limit?: number }): Promise<Job[]>;
	get(input: { agent?: string; id: string }): Promise<Job | undefined>;
	list(input?: { agent?: string; limit?: number; offset?: number }): Promise<Job[]>;
	setState(input: { agent?: string; id: string }, state: JobState): Promise<void>;
	runNow(input: { agent?: string; id: string }): Promise<void>;
	finish(input: { agent: string; id: string }, result: { nextAt?: number; lastAt: number }): Promise<void>;
	pauseMissing(agent: string, ids: string[]): Promise<number>;
}

/** Durable history for one scheduled job attempt. */
export interface JobRuns {
	create(input: {
		jobAgent: string;
		jobId: string;
		threadId?: string;
		trace: string;
	}): Promise<{ row: JobRun; inserted: boolean }>;
	finish(
		id: string,
		input: { state: JobRunState; output?: string; error?: string; deliveryState?: DeliveryState },
	): Promise<void>;
	lastForJob(input: { agent: string; id: string }): Promise<JobRun | undefined>;
}

/** Complete persistence boundary used by heypi core. Implementations may use SQLite, libSQL, or other stores. */
export interface Store {
	threads: Threads;
	messages: Messages;
	turns: Turns;
	calls: Calls;
	approvals: Approvals;
	/** Required when scheduled jobs are enabled. */
	jobs?: Jobs;
	/** Required when scheduled jobs are enabled. */
	jobRuns?: JobRuns;
	/** Required for thread locking and scheduled job claims. */
	locks?: Locks;
	/** Runs related store writes atomically. Nested transactions are not supported. */
	transaction?<T>(fn: (store: Store) => Promise<T>): Promise<T>;
	setup(): Promise<void>;
}
