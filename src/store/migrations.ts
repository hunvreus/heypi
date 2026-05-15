export const MIGRATIONS = [
	{
		name: "0000_melodic_doctor_doom.sql",
		content: `CREATE TABLE \`approval\` (
	\`id\` text PRIMARY KEY NOT NULL,
	\`call_id\` text NOT NULL,
	\`channel\` text NOT NULL,
	\`thread_id\` text,
	\`turn_id\` text,
	\`request_message_id\` text,
	\`command\` text NOT NULL,
	\`runtime\` text NOT NULL,
	\`reason\` text NOT NULL,
	\`state\` text NOT NULL,
	\`requested_by\` text,
	\`requested_at\` integer NOT NULL,
	\`expires_at\` integer,
	\`resolved_at\` integer,
	\`resolved_by\` text
);
--> statement-breakpoint
CREATE INDEX \`approval_call_idx\` ON \`approval\` (\`call_id\`);--> statement-breakpoint
CREATE TABLE \`call\` (
	\`id\` text PRIMARY KEY NOT NULL,
	\`turn_id\` text,
	\`thread_id\` text,
	\`message_id\` text,
	\`channel\` text NOT NULL,
	\`actor\` text,
	\`tool\` text NOT NULL,
	\`tool_call_id\` text,
	\`command\` text,
	\`args\` text,
	\`runtime\` text,
	\`policy_reason\` text,
	\`state\` text NOT NULL,
	\`code\` integer,
	\`out\` text,
	\`err\` text,
	\`ms\` integer,
	\`queue_wait_ms\` integer,
	\`created_at\` integer NOT NULL,
	\`updated_at\` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX \`call_channel_idx\` ON \`call\` (\`channel\`);--> statement-breakpoint
CREATE INDEX \`call_turn_idx\` ON \`call\` (\`turn_id\`);--> statement-breakpoint
CREATE TABLE \`job\` (
	\`id\` text PRIMARY KEY NOT NULL,
	\`agent\` text NOT NULL,
	\`kind\` text NOT NULL,
	\`schedule\` text NOT NULL,
	\`scope\` text,
	\`target\` text,
	\`prompt\` text NOT NULL,
	\`state\` text NOT NULL,
	\`next_at\` integer,
	\`last_at\` integer,
	\`idle_ms\` integer,
	\`created_at\` integer NOT NULL,
	\`updated_at\` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX \`job_state_next_idx\` ON \`job\` (\`state\`,\`next_at\`);--> statement-breakpoint
CREATE TABLE \`job_run\` (
	\`id\` text PRIMARY KEY NOT NULL,
	\`job_id\` text NOT NULL,
	\`thread_id\` text,
	\`trace\` text NOT NULL,
	\`state\` text NOT NULL,
	\`output\` text,
	\`error\` text,
	\`delivery_state\` text NOT NULL,
	\`started_at\` integer NOT NULL,
	\`ended_at\` integer
);
--> statement-breakpoint
CREATE INDEX \`job_run_job_idx\` ON \`job_run\` (\`job_id\`);--> statement-breakpoint
CREATE UNIQUE INDEX \`job_run_trace_idx\` ON \`job_run\` (\`trace\`);--> statement-breakpoint
CREATE TABLE \`lock\` (
	\`key\` text PRIMARY KEY NOT NULL,
	\`owner\` text NOT NULL,
	\`expires_at\` integer NOT NULL,
	\`created_at\` integer NOT NULL,
	\`updated_at\` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE \`message\` (
	\`id\` text PRIMARY KEY NOT NULL,
	\`thread_id\` text NOT NULL,
	\`provider\` text NOT NULL,
	\`provider_event_id\` text,
	\`role\` text NOT NULL,
	\`actor\` text,
	\`tool_call_id\` text,
	\`text\` text NOT NULL,
	\`data\` text,
	\`state\` text NOT NULL,
	\`created_at\` integer NOT NULL,
	\`updated_at\` integer NOT NULL
);
--> statement-breakpoint
	CREATE UNIQUE INDEX \`message_provider_event_idx\` ON \`message\` (\`provider\`,\`thread_id\`,\`provider_event_id\`);--> statement-breakpoint
CREATE INDEX \`message_tool_call_idx\` ON \`message\` (\`thread_id\`,\`tool_call_id\`);--> statement-breakpoint
CREATE TABLE \`thread\` (
	\`id\` text PRIMARY KEY NOT NULL,
	\`agent\` text NOT NULL,
	\`provider\` text NOT NULL,
	\`team\` text DEFAULT '' NOT NULL,
	\`channel\` text NOT NULL,
	\`actor\` text,
	\`key\` text NOT NULL,
	\`created_at\` integer NOT NULL,
	\`updated_at\` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX \`thread_agent_provider_team_key_idx\` ON \`thread\` (\`agent\`,\`provider\`,\`team\`,\`key\`);--> statement-breakpoint
CREATE TABLE \`turn\` (
	\`id\` text PRIMARY KEY NOT NULL,
	\`thread_id\` text NOT NULL,
	\`input_message_id\` text NOT NULL,
	\`result_message_id\` text,
	\`agent\` text NOT NULL,
	\`provider\` text NOT NULL,
	\`channel\` text NOT NULL,
	\`actor\` text,
	\`trace\` text,
	\`state\` text NOT NULL,
	\`created_at\` integer NOT NULL,
	\`updated_at\` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX \`turn_thread_idx\` ON \`turn\` (\`thread_id\`);`,
	},
] as const;
