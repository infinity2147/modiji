import { index, integer, primaryKey, sqliteTable, text, unique } from "drizzle-orm/sqlite-core";
import { LEDGER_SOURCES } from "../../schemas/ledger";

/** Mutable per-session state. Every change to it is mirrored by an append to the ledger. */
export const sessions = sqliteTable("sessions", {
  id: text("id").primaryKey(),
  createdAt: integer("created_at").notNull(),
  privacyEpoch: integer("privacy_epoch").notNull().default(0),
  offRecord: integer("off_record", { mode: "boolean" }).notNull().default(false),
  nextSequence: integer("next_sequence").notNull().default(0),
});

/** Append-only (enforced by triggers). `parent_ids` and `payload` hold JSON text. */
export const ledgerEntries = sqliteTable(
  "ledger_entries",
  {
    id: text("id").primaryKey(),
    sessionId: text("session_id")
      .notNull()
      .references(() => sessions.id),
    sequence: integer("sequence").notNull(),
    source: text("source", { enum: LEDGER_SOURCES }).notNull(),
    kind: text("kind").notNull(),
    occurredAt: integer("occurred_at").notNull(),
    receivedAt: integer("received_at").notNull(),
    traceId: text("trace_id").notNull(),
    parentIds: text("parent_ids").notNull(),
    schemaVersion: integer("schema_version").notNull(),
    privacyEpoch: integer("privacy_epoch").notNull(),
    payload: text("payload").notNull(),
  },
  (t) => [
    unique("ledger_entries_session_sequence_unique").on(t.sessionId, t.sequence),
    index("ledger_entries_session_source_idx").on(t.sessionId, t.source),
    index("ledger_entries_trace_idx").on(t.traceId),
    // The rulebook, expert directory and disagreement holds read only new rows of a few kinds (kind = ? AND rowid > ?).
    index("ledger_entries_kind_idx").on(t.kind),
    // One session's entries of a kind: the archived check on every append, a newly expert session's rule rows.
    index("ledger_entries_session_kind_idx").on(t.sessionId, t.kind),
  ],
);

/** Provenance DAG (child derived from parent), for lineage walks in both directions. Append-only. */
export const ledgerEdges = sqliteTable(
  "ledger_edges",
  {
    childId: text("child_id")
      .notNull()
      .references(() => ledgerEntries.id),
    parentId: text("parent_id")
      .notNull()
      .references(() => ledgerEntries.id),
  },
  (t) => [primaryKey({ columns: [t.childId, t.parentId] }), index("ledger_edges_parent_idx").on(t.parentId)],
);
