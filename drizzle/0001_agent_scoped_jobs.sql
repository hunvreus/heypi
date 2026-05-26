CREATE TABLE `job_run_new` (
	`id` text PRIMARY KEY NOT NULL,
	`job_agent` text NOT NULL,
	`job_id` text NOT NULL,
	`thread_id` text,
	`trace` text NOT NULL,
	`state` text NOT NULL,
	`output` text,
	`error` text,
	`delivery_state` text NOT NULL,
	`started_at` integer NOT NULL,
	`ended_at` integer
);
--> statement-breakpoint
INSERT INTO `job_run_new` (
	`id`,
	`job_agent`,
	`job_id`,
	`thread_id`,
	`trace`,
	`state`,
	`output`,
	`error`,
	`delivery_state`,
	`started_at`,
	`ended_at`
)
SELECT
	`job_run`.`id`,
	coalesce(`job`.`agent`, ''),
	`job_run`.`job_id`,
	`job_run`.`thread_id`,
	`job_run`.`trace`,
	`job_run`.`state`,
	`job_run`.`output`,
	`job_run`.`error`,
	`job_run`.`delivery_state`,
	`job_run`.`started_at`,
	`job_run`.`ended_at`
FROM `job_run`
LEFT JOIN `job` ON `job`.`id` = `job_run`.`job_id`;
--> statement-breakpoint
DROP TABLE `job_run`;
--> statement-breakpoint
ALTER TABLE `job_run_new` RENAME TO `job_run`;
--> statement-breakpoint
CREATE INDEX `job_run_job_idx` ON `job_run` (`job_agent`,`job_id`);
--> statement-breakpoint
CREATE UNIQUE INDEX `job_run_trace_idx` ON `job_run` (`trace`);
--> statement-breakpoint
CREATE TABLE `job_new` (
	`id` text NOT NULL,
	`agent` text NOT NULL,
	`kind` text NOT NULL,
	`schedule` text NOT NULL,
	`scope` text,
	`target` text,
	`prompt` text NOT NULL,
	`state` text NOT NULL,
	`next_at` integer,
	`last_at` integer,
	`idle_ms` integer,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	PRIMARY KEY(`agent`, `id`)
);
--> statement-breakpoint
INSERT INTO `job_new` (
	`id`,
	`agent`,
	`kind`,
	`schedule`,
	`scope`,
	`target`,
	`prompt`,
	`state`,
	`next_at`,
	`last_at`,
	`idle_ms`,
	`created_at`,
	`updated_at`
)
SELECT
	`id`,
	`agent`,
	`kind`,
	`schedule`,
	`scope`,
	`target`,
	`prompt`,
	`state`,
	`next_at`,
	`last_at`,
	`idle_ms`,
	`created_at`,
	`updated_at`
FROM `job`;
--> statement-breakpoint
DROP TABLE `job`;
--> statement-breakpoint
ALTER TABLE `job_new` RENAME TO `job`;
--> statement-breakpoint
CREATE INDEX `job_agent_state_next_idx` ON `job` (`agent`,`state`,`next_at`);
