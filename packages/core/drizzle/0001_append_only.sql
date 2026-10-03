-- The ledger is append-only: rows in ledger_entries and ledger_edges can never be changed or removed.
CREATE TRIGGER `ledger_entries_no_update` BEFORE UPDATE ON `ledger_entries`
BEGIN SELECT RAISE(ABORT, 'ledger_entries is append-only'); END;
--> statement-breakpoint
CREATE TRIGGER `ledger_entries_no_delete` BEFORE DELETE ON `ledger_entries`
BEGIN SELECT RAISE(ABORT, 'ledger_entries is append-only'); END;
--> statement-breakpoint
CREATE TRIGGER `ledger_edges_no_update` BEFORE UPDATE ON `ledger_edges`
BEGIN SELECT RAISE(ABORT, 'ledger_edges is append-only'); END;
--> statement-breakpoint
CREATE TRIGGER `ledger_edges_no_delete` BEFORE DELETE ON `ledger_edges`
BEGIN SELECT RAISE(ABORT, 'ledger_edges is append-only'); END;
--> statement-breakpoint
-- Session counters only move forward: a privacy epoch is never reused and sequences stay gap-free.
CREATE TRIGGER `sessions_monotonic` BEFORE UPDATE ON `sessions`
WHEN NEW.`id` IS NOT OLD.`id`
  OR NEW.`created_at` IS NOT OLD.`created_at`
  OR NEW.`privacy_epoch` < OLD.`privacy_epoch`
  OR NEW.`next_sequence` < OLD.`next_sequence`
BEGIN SELECT RAISE(ABORT, 'sessions: id and created_at are immutable; privacy_epoch and next_sequence never decrease'); END;
