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
CREATE INDEX `event_agent_created_idx` ON `event` (`agent`,`created_at`);