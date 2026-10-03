CREATE TABLE `ledger_edges` (
	`child_id` text NOT NULL,
	`parent_id` text NOT NULL,
	PRIMARY KEY(`child_id`, `parent_id`),
	FOREIGN KEY (`child_id`) REFERENCES `ledger_entries`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`parent_id`) REFERENCES `ledger_entries`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `ledger_edges_parent_idx` ON `ledger_edges` (`parent_id`);--> statement-breakpoint
CREATE TABLE `ledger_entries` (
	`id` text PRIMARY KEY NOT NULL,
	`session_id` text NOT NULL,
	`sequence` integer NOT NULL,
	`source` text NOT NULL,
	`kind` text NOT NULL,
	`occurred_at` integer NOT NULL,
	`received_at` integer NOT NULL,
	`trace_id` text NOT NULL,
	`parent_ids` text NOT NULL,
	`schema_version` integer NOT NULL,
	`privacy_epoch` integer NOT NULL,
	`payload` text NOT NULL,
	FOREIGN KEY (`session_id`) REFERENCES `sessions`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `ledger_entries_session_source_idx` ON `ledger_entries` (`session_id`,`source`);--> statement-breakpoint
CREATE INDEX `ledger_entries_trace_idx` ON `ledger_entries` (`trace_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `ledger_entries_session_sequence_unique` ON `ledger_entries` (`session_id`,`sequence`);--> statement-breakpoint
CREATE TABLE `sessions` (
	`id` text PRIMARY KEY NOT NULL,
	`created_at` integer NOT NULL,
	`privacy_epoch` integer DEFAULT 0 NOT NULL,
	`off_record` integer DEFAULT false NOT NULL,
	`next_sequence` integer DEFAULT 0 NOT NULL
);
