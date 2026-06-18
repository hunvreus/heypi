ALTER TABLE `call` ADD `trace` text;--> statement-breakpoint
CREATE INDEX `call_trace_idx` ON `call` (`trace`);