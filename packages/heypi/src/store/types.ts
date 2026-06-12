import type { SessionMessageEntry } from "@earendil-works/pi-coding-agent";
import type { ApprovalBypassScope } from "../config.js";
import type { CallErrorKind, CallState, TurnState } from "../core/types.js";
import type { approval, approvalBypass, call, job, jobRun, lock, message, thread, turn } from "../db/schema.js";
import type { JobState } from "../job.js";

export type StoredMessage = SessionMessageEntry["message"];

export type Thread = typeof thread.$inferSelect;

export type Message = typeof message.$inferSelect;

export type MessageWithThread = Message & {
	agent: string;
	channel: string;
	threadActor: string | null;
};

export type HistoryMessage = Pick<Message, "id" | "role" | "actor" | "text" | "createdAt">;

export type Turn = typeof turn.$inferSelect;

export type Call = typeof call.$inferSelect;

export type Approval = typeof approval.$inferSelect;

export type ApprovalBypass = typeof approvalBypass.$inferSelect;

export type Lock = typeof lock.$inferSelect;

export type JobRunState = "running" | "done" | "failed" | "skipped";
export type DeliveryState = "pending" | "delivered" | "failed" | "none";

export type Job = typeof job.$inferSelect;

export type JobRun = typeof jobRun.$inferSelect;

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
	getByProviderEvent(provider: string, threadId: string, eventId: string): Promise<Message | undefined>;
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
	listRecent?(input?: { agent?: string; limit?: number; offset?: number }): Promise<MessageWithThread[]>;
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
		agent: string;
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
	get(id: string, input?: { agent?: string }): Promise<Call | undefined>;
	getByChannel(channel: string, id: string, input?: { agent?: string }): Promise<Call | undefined>;
	listForThread(threadId: string, input?: { agent?: string; states?: CallState[]; limit?: number }): Promise<Call[]>;
	listRecent?(input?: { agent?: string; states?: CallState[]; limit?: number; offset?: number }): Promise<Call[]>;
	failRunning?(input: { agent: string; error: string }): Promise<number>;
	setState(id: string, state: CallState, input?: { agent?: string }): Promise<void>;
	finish(
		id: string,
		input: {
			state: CallState;
			code: number;
			out: string;
			err: string;
			errKind?: CallErrorKind;
			ms: number;
			queueWaitMs: number;
		},
	): Promise<void>;
}

/** Approval store for calls that require human confirmation before execution. */
export interface Approvals {
	create(input: {
		agent: string;
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
		snapshot?: string;
	}): Promise<Approval>;
	get(id: string, input?: { agent?: string }): Promise<Approval | undefined>;
	getByChannel(channel: string, id: string, input?: { agent?: string }): Promise<Approval | undefined>;
	getPending(channel: string, id: string, input?: { agent?: string }): Promise<Approval | undefined>;
	listForThread?(threadId: string, input?: { agent?: string; limit?: number; offset?: number }): Promise<Approval[]>;
	listPending(input?: {
		agent?: string;
		threadId?: string;
		turnId?: string;
		limit?: number;
		offset?: number;
	}): Promise<Approval[]>;
	resolve(
		id: string,
		state: "approved" | "denied" | "expired",
		actor: string,
		input?: { agent?: string },
	): Promise<boolean>;
}

/** Temporary approval bypasses created by human approvers. */
export interface ApprovalBypasses {
	create(input: {
		agent: string;
		scope: ApprovalBypassScope;
		channel: string;
		threadId?: string;
		actor?: string;
		createdBy: string;
		reason?: string;
		approvalId?: string;
		expiresAt: number;
	}): Promise<ApprovalBypass>;
	active(input: {
		agent: string;
		channel: string;
		threadId?: string;
		actor?: string;
		now?: number;
	}): Promise<ApprovalBypass | undefined>;
	listActive(input?: { agent?: string; limit?: number; offset?: number; now?: number }): Promise<ApprovalBypass[]>;
	revoke(id: string, actor: string, input?: { agent?: string }): Promise<boolean>;
}

/** Durable concurrency guard for logical conversation processing across processes. */
export interface Locks {
	acquire(input: { key: string; owner: string; ttlMs?: number }): Promise<Lock | undefined>;
	get(key: string): Promise<Lock | undefined>;
	refresh(input: { key: string; owner: string; ttlMs?: number }): Promise<Lock | undefined>;
	release(input: { key: string; owner: string }): Promise<void>;
	clear?(input?: { key?: string; prefix?: string }): Promise<number>;
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
	finish(input: { agent: string; id: string }, result: { nextAt: number | null; lastAt: number }): Promise<void>;
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
	failRunning?(input: { agent: string; error: string }): Promise<number>;
}

/** Complete persistence boundary used by heypi core. Implementations may use SQLite, libSQL, or other stores. */
export interface Store {
	threads: Threads;
	messages: Messages;
	turns: Turns;
	calls: Calls;
	approvals: Approvals;
	approvalBypasses?: ApprovalBypasses;
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
