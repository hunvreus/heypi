CREATE TABLE `approval_bypass` (
	`id` text PRIMARY KEY NOT NULL,
	`agent` text NOT NULL,
	`scope` text NOT NULL,
	`channel` text NOT NULL,
	`thread_id` text,
	`actor` text NOT NULL,
	`created_by` text NOT NULL,
	`reason` text,
	`approval_id` text,
	`created_at` integer NOT NULL,
	`expires_at` integer NOT NULL,
	`revoked_at` integer,
	`revoked_by` text
);
--> statement-breakpoint
CREATE INDEX `approval_bypass_agent_active_idx` ON `approval_bypass` (`agent`,`expires_at`,`revoked_at`);--> statement-breakpoint
CREATE INDEX `approval_bypass_agent_channel_idx` ON `approval_bypass` (`agent`,`channel`);--> statement-breakpoint
CREATE TABLE `event` (
	`id` text PRIMARY KEY NOT NULL,
	`agent` text NOT NULL,
	`trace` text NOT NULL,
	`thread_id` text,
	`turn_id` text,
	`call_id` text,
	`approval_id` text,
	`job_run_id` text,
	`seq` integer NOT NULL,
	`type` text NOT NULL,
	`data` text NOT NULL,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `event_agent_trace_seq_idx` ON `event` (`agent`,`trace`,`seq`);--> statement-breakpoint
CREATE UNIQUE INDEX `event_trace_seq_idx` ON `event` (`trace`,`seq`);--> statement-breakpoint
CREATE INDEX `event_thread_created_idx` ON `event` (`thread_id`,`created_at`);--> statement-breakpoint
CREATE INDEX `event_turn_seq_idx` ON `event` (`turn_id`,`seq`);--> statement-breakpoint
CREATE INDEX `event_call_seq_idx` ON `event` (`call_id`,`seq`);--> statement-breakpoint
CREATE INDEX `event_approval_seq_idx` ON `event` (`approval_id`,`seq`);--> statement-breakpoint
CREATE INDEX `event_job_run_seq_idx` ON `event` (`job_run_id`,`seq`);--> statement-breakpoint
CREATE INDEX `event_agent_created_idx` ON `event` (`agent`,`created_at`);--> statement-breakpoint
CREATE TABLE `provider_message` (
	`id` text PRIMARY KEY NOT NULL,
	`agent` text NOT NULL,
	`provider` text NOT NULL,
	`team` text DEFAULT '' NOT NULL,
	`channel` text NOT NULL,
	`provider_message_id` text NOT NULL,
	`thread_id` text NOT NULL,
	`actor` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `provider_message_identity_idx` ON `provider_message` (`agent`,`provider`,`team`,`channel`,`provider_message_id`);--> statement-breakpoint
CREATE INDEX `provider_message_thread_idx` ON `provider_message` (`thread_id`);--> statement-breakpoint
ALTER TABLE `call` ADD `trace` text;--> statement-breakpoint
CREATE INDEX `call_trace_idx` ON `call` (`trace`);--> statement-breakpoint
ALTER TABLE `job_run` ADD `due_at` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `job_run` ADD `target_key` text DEFAULT '' NOT NULL;--> statement-breakpoint
ALTER TABLE `job_run` ADD `adapter` text;--> statement-breakpoint
ALTER TABLE `job_run` ADD `channel` text;--> statement-breakpoint
ALTER TABLE `job_run` ADD `thread_key` text;--> statement-breakpoint
ALTER TABLE `job_run` ADD `target` text;--> statement-breakpoint
ALTER TABLE `job_run` ADD `available_at` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `job_run` ADD `claimed_by` text;--> statement-breakpoint
ALTER TABLE `job_run` ADD `attempts` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `job_run` ADD `created_at` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
CREATE INDEX `job_run_state_available_idx` ON `job_run` (`state`,`available_at`);--> statement-breakpoint
CREATE INDEX `job_run_job_state_idx` ON `job_run` (`job_agent`,`job_id`,`state`);--> statement-breakpoint
CREATE INDEX `job_run_occurrence_idx` ON `job_run` (`job_agent`,`job_id`,`due_at`,`target_key`);