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
CREATE INDEX `provider_message_thread_idx` ON `provider_message` (`thread_id`);