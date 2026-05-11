CREATE TABLE `approval` (
	`id` text PRIMARY KEY NOT NULL,
	`call_id` text NOT NULL,
	`channel` text NOT NULL,
	`thread_id` text,
	`turn_id` text,
	`request_message_id` text,
	`command` text NOT NULL,
	`runtime` text NOT NULL,
	`reason` text NOT NULL,
	`state` text NOT NULL,
	`requested_by` text,
	`requested_at` integer NOT NULL,
	`expires_at` integer,
	`resolved_at` integer,
	`resolved_by` text
);
--> statement-breakpoint
CREATE INDEX `approval_call_idx` ON `approval` (`call_id`);--> statement-breakpoint
CREATE TABLE `call` (
	`id` text PRIMARY KEY NOT NULL,
	`turn_id` text,
	`thread_id` text,
	`message_id` text,
	`channel` text NOT NULL,
	`actor` text,
	`tool` text NOT NULL,
	`tool_call_id` text,
	`command` text,
	`args` text,
	`runtime` text,
	`policy_reason` text,
	`state` text NOT NULL,
	`code` integer,
	`out` text,
	`err` text,
	`ms` integer,
	`queue_wait_ms` integer,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `call_channel_idx` ON `call` (`channel`);--> statement-breakpoint
CREATE INDEX `call_turn_idx` ON `call` (`turn_id`);--> statement-breakpoint
CREATE TABLE `message` (
	`id` text PRIMARY KEY NOT NULL,
	`thread_id` text NOT NULL,
	`provider` text NOT NULL,
	`provider_event_id` text,
	`role` text NOT NULL,
	`actor` text,
	`text` text NOT NULL,
	`data` text,
	`state` text NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `message_provider_event_idx` ON `message` (`provider`,`provider_event_id`);--> statement-breakpoint
CREATE TABLE `thread` (
	`id` text PRIMARY KEY NOT NULL,
	`agent` text NOT NULL,
	`provider` text NOT NULL,
	`channel` text NOT NULL,
	`actor` text,
	`key` text NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `thread_agent_provider_key_idx` ON `thread` (`agent`,`provider`,`key`);--> statement-breakpoint
CREATE TABLE `turn` (
	`id` text PRIMARY KEY NOT NULL,
	`thread_id` text NOT NULL,
	`input_message_id` text NOT NULL,
	`result_message_id` text,
	`agent` text NOT NULL,
	`provider` text NOT NULL,
	`channel` text NOT NULL,
	`actor` text,
	`trace` text,
	`state` text NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `turn_thread_idx` ON `turn` (`thread_id`);