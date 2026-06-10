CREATE TABLE `approval_bypass` (
	`id` text PRIMARY KEY NOT NULL,
	`agent` text NOT NULL,
	`scope` text NOT NULL,
	`channel` text NOT NULL,
	`thread_id` text,
	`actor` text,
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
CREATE INDEX `approval_bypass_agent_channel_idx` ON `approval_bypass` (`agent`,`channel`);
