import { index, integer, primaryKey, sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core";
import type { RuntimeErrorKind } from "../runtime/errors.js";

export const thread = sqliteTable(
	"thread",
	{
		id: text("id").primaryKey(),
		agent: text("agent").notNull(),
		provider: text("provider").notNull(),
		kind: text("kind").notNull().default(""),
		team: text("team").notNull().default(""),
		channel: text("channel").notNull(),
		actor: text("actor"),
		key: text("key").notNull(),
		sessionId: text("session_id").notNull(),
		sessionPath: text("session_path").notNull(),
		createdAt: integer("created_at").notNull(),
		updatedAt: integer("updated_at").notNull(),
	},
	(table) => [
		uniqueIndex("thread_agent_provider_team_key_idx").on(table.agent, table.provider, table.team, table.key),
	],
);

export const message = sqliteTable(
	"message",
	{
		id: text("id").primaryKey(),
		threadId: text("thread_id").notNull(),
		provider: text("provider").notNull(),
		kind: text("kind").notNull().default(""),
		providerEventId: text("provider_event_id"),
		role: text("role").notNull(),
		actor: text("actor"),
		text: text("text").notNull(),
		data: text("data"),
		state: text("state").notNull(),
		createdAt: integer("created_at").notNull(),
		updatedAt: integer("updated_at").notNull(),
	},
	(table) => [uniqueIndex("message_provider_event_idx").on(table.provider, table.threadId, table.providerEventId)],
);

export const turn = sqliteTable(
	"turn",
	{
		id: text("id").primaryKey(),
		threadId: text("thread_id").notNull(),
		inputMessageId: text("input_message_id").notNull(),
		resultMessageId: text("result_message_id"),
		agent: text("agent").notNull(),
		provider: text("provider").notNull(),
		kind: text("kind").notNull().default(""),
		channel: text("channel").notNull(),
		actor: text("actor"),
		trace: text("trace"),
		state: text("state").notNull(),
		createdAt: integer("created_at").notNull(),
		updatedAt: integer("updated_at").notNull(),
	},
	(table) => [index("turn_thread_idx").on(table.threadId)],
);

export const call = sqliteTable(
	"call",
	{
		id: text("id").primaryKey(),
		agent: text("agent").notNull(),
		turnId: text("turn_id"),
		threadId: text("thread_id"),
		messageId: text("message_id"),
		channel: text("channel").notNull(),
		actor: text("actor"),
		tool: text("tool").notNull(),
		toolCallId: text("tool_call_id"),
		command: text("command"),
		args: text("args"),
		runtime: text("runtime"),
		policyReason: text("policy_reason"),
		state: text("state").notNull(),
		code: integer("code"),
		out: text("out"),
		err: text("err"),
		errKind: text("err_kind").$type<RuntimeErrorKind>(),
		ms: integer("ms"),
		queueWaitMs: integer("queue_wait_ms"),
		createdAt: integer("created_at").notNull(),
		updatedAt: integer("updated_at").notNull(),
	},
	(table) => [
		index("call_channel_idx").on(table.channel),
		index("call_turn_idx").on(table.turnId),
		index("call_agent_channel_idx").on(table.agent, table.channel),
		index("call_agent_updated_idx").on(table.agent, table.updatedAt),
	],
);

export const approval = sqliteTable(
	"approval",
	{
		id: text("id").primaryKey(),
		agent: text("agent").notNull(),
		callId: text("call_id").notNull(),
		channel: text("channel").notNull(),
		threadId: text("thread_id"),
		turnId: text("turn_id"),
		requestMessageId: text("request_message_id"),
		command: text("command").notNull(),
		runtime: text("runtime").notNull(),
		reason: text("reason").notNull(),
		details: text("details"),
		state: text("state").notNull(),
		requestedBy: text("requested_by"),
		requestedAt: integer("requested_at").notNull(),
		expiresAt: integer("expires_at"),
		resolvedAt: integer("resolved_at"),
		resolvedBy: text("resolved_by"),
	},
	(table) => [
		index("approval_call_idx").on(table.callId),
		index("approval_agent_channel_idx").on(table.agent, table.channel),
		index("approval_agent_state_requested_idx").on(table.agent, table.state, table.requestedAt),
	],
);

export const approvalBypass = sqliteTable(
	"approval_bypass",
	{
		id: text("id").primaryKey(),
		agent: text("agent").notNull(),
		scope: text("scope").notNull(),
		channel: text("channel").notNull(),
		threadId: text("thread_id"),
		actor: text("actor").notNull(),
		createdBy: text("created_by").notNull(),
		reason: text("reason"),
		approvalId: text("approval_id"),
		createdAt: integer("created_at").notNull(),
		expiresAt: integer("expires_at").notNull(),
		revokedAt: integer("revoked_at"),
		revokedBy: text("revoked_by"),
	},
	(table) => [
		index("approval_bypass_agent_active_idx").on(table.agent, table.expiresAt, table.revokedAt),
		index("approval_bypass_agent_channel_idx").on(table.agent, table.channel),
	],
);

export const lock = sqliteTable(
	"lock",
	{
		key: text("key").primaryKey(),
		owner: text("owner").notNull(),
		expiresAt: integer("expires_at").notNull(),
		createdAt: integer("created_at").notNull(),
		updatedAt: integer("updated_at").notNull(),
	},
	(table) => [index("lock_expires_idx").on(table.expiresAt)],
);

export const job = sqliteTable(
	"job",
	{
		id: text("id").notNull(),
		agent: text("agent").notNull(),
		kind: text("kind").notNull(),
		schedule: text("schedule").notNull(),
		scope: text("scope"),
		target: text("target"),
		prompt: text("prompt").notNull(),
		state: text("state").notNull(),
		nextAt: integer("next_at"),
		lastAt: integer("last_at"),
		idleMs: integer("idle_ms"),
		createdAt: integer("created_at").notNull(),
		updatedAt: integer("updated_at").notNull(),
	},
	(table) => [
		primaryKey({ columns: [table.agent, table.id] }),
		index("job_agent_state_next_idx").on(table.agent, table.state, table.nextAt),
	],
);

export const jobRun = sqliteTable(
	"job_run",
	{
		id: text("id").primaryKey(),
		jobAgent: text("job_agent").notNull(),
		jobId: text("job_id").notNull(),
		threadId: text("thread_id"),
		trace: text("trace").notNull(),
		dueAt: integer("due_at").notNull().default(0),
		targetKey: text("target_key").notNull().default(""),
		adapter: text("adapter"),
		channel: text("channel"),
		threadKey: text("thread_key"),
		target: text("target"),
		availableAt: integer("available_at").notNull().default(0),
		claimedBy: text("claimed_by"),
		attempts: integer("attempts").notNull().default(0),
		state: text("state").notNull(),
		output: text("output"),
		error: text("error"),
		deliveryState: text("delivery_state").notNull(),
		createdAt: integer("created_at").notNull().default(0),
		startedAt: integer("started_at").notNull(),
		endedAt: integer("ended_at"),
	},
	(table) => [
		index("job_run_job_idx").on(table.jobAgent, table.jobId),
		index("job_run_state_available_idx").on(table.state, table.availableAt),
		index("job_run_job_state_idx").on(table.jobAgent, table.jobId, table.state),
		uniqueIndex("job_run_trace_idx").on(table.trace),
		index("job_run_occurrence_idx").on(table.jobAgent, table.jobId, table.dueAt, table.targetKey),
	],
);
