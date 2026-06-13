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