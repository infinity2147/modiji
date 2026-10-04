-- Indexes only: no row of ledger_entries is touched, so the append-only triggers (0001) are unaffected.
-- IF NOT EXISTS keeps the migration safe on a production database where an index was created by hand.
CREATE INDEX IF NOT EXISTS `ledger_entries_kind_idx` ON `ledger_entries` (`kind`);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `ledger_entries_session_kind_idx` ON `ledger_entries` (`session_id`,`kind`);
