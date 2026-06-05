CREATE TABLE `session_blob` (
	`session_id` text PRIMARY KEY NOT NULL,
	`entries` text NOT NULL,
	`updated_at` integer NOT NULL
);
