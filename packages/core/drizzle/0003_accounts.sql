CREATE TABLE `account_events` (
	`id` text PRIMARY KEY NOT NULL,
	`at` integer NOT NULL,
	`actor_id` text,
	`subject_id` text NOT NULL,
	`kind` text NOT NULL,
	`detail` text NOT NULL,
	FOREIGN KEY (`actor_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`subject_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `account_events_subject_idx` ON `account_events` (`subject_id`);--> statement-breakpoint
CREATE TABLE `auth_sessions` (
	`token_hash` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`created_at` integer NOT NULL,
	`expires_at` integer NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `auth_sessions_user_idx` ON `auth_sessions` (`user_id`);--> statement-breakpoint
CREATE TABLE `users` (
	`id` text PRIMARY KEY NOT NULL,
	`username` text NOT NULL,
	`display_name` text NOT NULL,
	`role` text NOT NULL,
	`expert_requested` integer DEFAULT false NOT NULL,
	`password_hash` text NOT NULL,
	`created_at` integer NOT NULL,
	`disabled_at` integer
);
--> statement-breakpoint
CREATE UNIQUE INDEX `users_username_unique` ON `users` (`username`);--> statement-breakpoint
-- The account audit trail is append-only, like the ledger: who granted whom which role can never be rewritten.
CREATE TRIGGER `account_events_no_update` BEFORE UPDATE ON `account_events`
BEGIN SELECT RAISE(ABORT, 'account_events is append-only'); END;
--> statement-breakpoint
CREATE TRIGGER `account_events_no_delete` BEFORE DELETE ON `account_events`
BEGIN SELECT RAISE(ABORT, 'account_events is append-only'); END;
--> statement-breakpoint
-- A role outside the known set would bypass every access rule that matches on it.
CREATE TRIGGER `users_role_insert` BEFORE INSERT ON `users`
WHEN NEW.`role` NOT IN ('trainee', 'expert', 'admin')
BEGIN SELECT RAISE(ABORT, 'users.role must be trainee, expert or admin'); END;
--> statement-breakpoint
CREATE TRIGGER `users_role_update` BEFORE UPDATE OF `role` ON `users`
WHEN NEW.`role` NOT IN ('trainee', 'expert', 'admin')
BEGIN SELECT RAISE(ABORT, 'users.role must be trainee, expert or admin'); END;
--> statement-breakpoint
-- A username is an expert id in the ledger; it never changes.
CREATE TRIGGER `users_username_immutable` BEFORE UPDATE OF `username` ON `users`
WHEN NEW.`username` IS NOT OLD.`username`
BEGIN SELECT RAISE(ABORT, 'users.username is immutable'); END;
