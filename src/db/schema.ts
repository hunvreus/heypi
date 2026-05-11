import { index, integer, sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core";

export const thread = sqliteTable(
	"thread",
	{
		id: text("id").primaryKey(),
		agent: text("agent").notNull(),
		provider: text("provider").notNull(),
		channel: text("channel").notNull(),
		actor: text("actor"),
		key: text("key").notNull(),
		createdAt: integer("created_at").notNull(),
		updatedAt: integer("updated_at").notNull(),
	},
	(table) => [uniqueIndex("thread_agent_provider_key_idx").on(table.agent, table.provider, table.key)],
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
	(table) => [uniqueIndex("message_provider_event_idx").on(table.provider, table.providerEventId)],
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
