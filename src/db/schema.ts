import { index, integer, sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core";

export const thread = sqliteTable(
	"thread",
	{
		id: text("id").primaryKey(),
		agent: text("agent").notNull(),
		provider: text("provider").notNull(),
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
		ms: integer("ms"),
		queueWaitMs: integer("queue_wait_ms"),
		createdAt: integer("created_at").notNull(),
		updatedAt: integer("updated_at").notNull(),
	},
	(table) => [index("call_channel_idx").on(table.channel), index("call_turn_idx").on(table.turnId)],
);

export const approval = sqliteTable(
	"approval",
	{
		id: text("id").primaryKey(),
		callId: text("call_id").notNull(),
		channel: text("channel").notNull(),
		threadId: text("thread_id"),
		turnId: text("turn_id"),
		requestMessageId: text("request_message_id"),
		command: text("command").notNull(),
		runtime: text("runtime").notNull(),
		reason: text("reason").notNull(),
		state: text("state").notNull(),
		requestedBy: text("requested_by"),
		requestedAt: integer("requested_at").notNull(),
		expiresAt: integer("expires_at"),
		resolvedAt: integer("resolved_at"),
		resolvedBy: text("resolved_by"),
	},
	(table) => [index("approval_call_idx").on(table.callId)],
);

export const lock = sqliteTable("lock", {
	key: text("key").primaryKey(),
	owner: text("owner").notNull(),
	expiresAt: integer("expires_at").notNull(),
	createdAt: integer("created_at").notNull(),
	updatedAt: integer("updated_at").notNull(),
});

export const job = sqliteTable(
	"job",
	{
		id: text("id").primaryKey(),
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
	(table) => [index("job_state_next_idx").on(table.state, table.nextAt)],
);

export const jobRun = sqliteTable(
	"job_run",
	{
		id: text("id").primaryKey(),
		jobId: text("job_id").notNull(),
		threadId: text("thread_id"),
		trace: text("trace").notNull(),
		state: text("state").notNull(),
		output: text("output"),
		error: text("error"),
		deliveryState: text("delivery_state").notNull(),
		startedAt: integer("started_at").notNull(),
		endedAt: integer("ended_at"),
	},
	(table) => [index("job_run_job_idx").on(table.jobId), uniqueIndex("job_run_trace_idx").on(table.trace)],
);
