import { randomUUID } from "node:crypto";
import { and, asc, eq, gt, inArray, sql, type SQL } from "drizzle-orm";
import { z } from "zod";
import {
  CAPTURE_SOURCES,
  EpochMsSchema,
  IdSchema,
  LEDGER_SOURCES,
  LedgerEntrySchema,
  NewLedgerEntrySchema,
  isEvidenceEligible,
  ledgerPayloadSchema,
  type LedgerEntry,
  type LedgerPayload,
  type LedgerSource,
  type NewLedgerEntry,
} from "../schemas";
import type { Db } from "./db/open";
import { ledgerEdges, ledgerEntries, sessions } from "./db/schema";

export type LedgerErrorCode =
  | "session_not_found"
  | "session_exists"
  | "parent_not_found"
  | "stale_epoch"
  | "off_record"
  | "invalid_entry"
  | "state_unchanged"
  | "session_archived";

export class LedgerError extends Error {
  override readonly name: string = "LedgerError";
  readonly code: LedgerErrorCode;

  constructor(code: LedgerErrorCode, message: string) {
    super(message);
    this.code = code;
  }
}

/** A capture entry was stamped with a privacy epoch other than the session's current one. */
export class StaleEpochError extends LedgerError {
  override readonly name: string = "StaleEpochError";
  readonly entryEpoch: number;
  readonly sessionEpoch: number;

  constructor(sessionId: string, entryEpoch: number, sessionEpoch: number) {
    super("stale_epoch", `privacy epoch ${entryEpoch} is stale for session ${sessionId} (current ${sessionEpoch})`);
    this.entryEpoch = entryEpoch;
    this.sessionEpoch = sessionEpoch;
  }
}

/** A capture entry arrived while the session is off the record. */
export class OffRecordError extends LedgerError {
  override readonly name: string = "OffRecordError";

  constructor(sessionId: string) {
    super("off_record", `session ${sessionId} is off the record; capture entries are refused`);
  }
}

/** The session was archived (`session.archived`): its ledger is closed, every further append is refused. */
export class SessionArchivedError extends LedgerError {
  override readonly name: string = "SessionArchivedError";

  constructor(sessionId: string) {
    super("session_archived", `session ${sessionId} is archived; it is read-only`);
  }
}

/** `archived`: the session's ledger holds a `session.archived` entry (derived from the ledger, never stored). */
export type Session = { id: string; createdAt: number; privacyEpoch: number; offRecord: boolean; archived: boolean };

export type LedgerFilter = {
  sources?: readonly LedgerSource[];
  kinds?: readonly string[];
  /** Only entries with a sequence strictly greater than this. */
  afterSequence?: number;
  limit?: number;
};

export type PrivacyTransitionMeta = { occurredAt: number; traceId: string };

export type LedgerOptions = { now?: () => number; newId?: () => string };

/** Schema version of the payload of `privacy.*` control entries. */
const PRIVACY_CONTROL_SCHEMA_VERSION = 1;

/** The ledger kind that closes a session, and its payload's schema version. */
export const SESSION_ARCHIVED_KIND = "session.archived";
const SESSION_ARCHIVED_SCHEMA_VERSION = 1;

export type ArchiveMeta = PrivacyTransitionMeta & LedgerPayload<typeof SESSION_ARCHIVED_KIND>;

const PrivacyTransitionMetaSchema = z.strictObject({ occurredAt: EpochMsSchema, traceId: IdSchema });

type Tx = Parameters<Parameters<Db["transaction"]>[0]>[0];
type EntryRow = typeof ledgerEntries.$inferSelect;
type SessionRow = typeof sessions.$inferSelect;

/** A validated entry with its payload already serialised, ready to insert. */
type PreparedEntry = { entry: NewLedgerEntry; payloadJson: string };

function invalid(message: string): LedgerError {
  return new LedgerError("invalid_entry", message);
}

function prepare(input: NewLedgerEntry): PreparedEntry {
  const parsed = NewLedgerEntrySchema.safeParse(input);
  if (!parsed.success) throw invalid(`invalid ledger entry: ${z.prettifyError(parsed.error)}`);
  let payloadJson: string | undefined;
  try {
    payloadJson = JSON.stringify(parsed.data.payload);
  } catch {
    payloadJson = undefined;
  }
  if (payloadJson === undefined) throw invalid("ledger entry payload is required and must be JSON-serialisable");
  return { entry: parsed.data, payloadJson };
}

function toSession(row: SessionRow, archived: boolean): Session {
  return { id: row.id, createdAt: row.createdAt, privacyEpoch: row.privacyEpoch, offRecord: row.offRecord, archived };
}

function toEntry(row: EntryRow): LedgerEntry {
  return LedgerEntrySchema.parse({
    id: row.id,
    sessionId: row.sessionId,
    sequence: row.sequence,
    source: row.source,
    kind: row.kind,
    occurredAt: row.occurredAt,
    receivedAt: row.receivedAt,
    traceId: row.traceId,
    parentIds: JSON.parse(row.parentIds),
    schemaVersion: row.schemaVersion,
    privacyEpoch: row.privacyEpoch,
    payload: JSON.parse(row.payload),
  });
}

/**
 * The append-only session ledger (plan §5, §6.1). Every write runs in one synchronous
 * IMMEDIATE transaction, so sequences stay gap-free even across processes sharing the file.
 * Payloads are stored as JSON; returned entries carry the JSON round-tripped payload.
 */
export function createLedger(db: Db, opts: LedgerOptions = {}) {
  const now = opts.now ?? Date.now;
  const newId = opts.newId ?? randomUUID;

  function sessionRow(conn: Db | Tx, id: string): SessionRow | undefined {
    return conn.select().from(sessions).where(eq(sessions.id, id)).get();
  }

  /** Whether the session's ledger holds its `session.archived` entry (indexed by session and source). */
  function isArchived(conn: Db | Tx, id: string): boolean {
    const row = conn
      .select({ id: ledgerEntries.id })
      .from(ledgerEntries)
      .where(and(eq(ledgerEntries.sessionId, id), eq(ledgerEntries.source, "engine"), eq(ledgerEntries.kind, SESSION_ARCHIVED_KIND)))
      .get();
    return row !== undefined;
  }

  function insert(tx: Tx, { entry, payloadJson }: PreparedEntry): LedgerEntry {
    const session = sessionRow(tx, entry.sessionId);
    if (!session) throw new LedgerError("session_not_found", `session ${entry.sessionId} not found`);
    // Archived is final: nothing more is appended to the session, by any source (the archive entry included).
    if (isArchived(tx, session.id)) throw new SessionArchivedError(session.id);
    if (CAPTURE_SOURCES.includes(entry.source)) {
      if (session.offRecord) throw new OffRecordError(session.id);
      if (entry.privacyEpoch !== session.privacyEpoch)
        throw new StaleEpochError(session.id, entry.privacyEpoch, session.privacyEpoch);
    }

    const parentIds = [...new Set(entry.parentIds)];
    if (parentIds.length > 0) {
      const found = new Set(
        tx
          .select({ id: ledgerEntries.id })
          .from(ledgerEntries)
          .where(inArray(ledgerEntries.id, parentIds))
          .all()
          .map((r) => r.id),
      );
      const missing = parentIds.filter((id) => !found.has(id));
      if (missing.length > 0) throw new LedgerError("parent_not_found", `parent entries not found: ${missing.join(", ")}`);
    }

    const row: EntryRow = {
      id: newId(),
      sessionId: session.id,
      sequence: session.nextSequence,
      source: entry.source,
      kind: entry.kind,
      occurredAt: entry.occurredAt,
      receivedAt: now(),
      traceId: entry.traceId,
      parentIds: JSON.stringify(entry.parentIds),
      schemaVersion: entry.schemaVersion,
      privacyEpoch: entry.privacyEpoch,
      payload: payloadJson,
    };
    // Validate before writing so a bad clock or id generator never leaves an unreadable row.
    const result = toEntry(row);
    tx.update(sessions)
      .set({ nextSequence: session.nextSequence + 1 })
      .where(eq(sessions.id, session.id))
      .run();
    tx.insert(ledgerEntries).values(row).run();
    if (parentIds.length > 0)
      tx.insert(ledgerEdges)
        .values(parentIds.map((parentId) => ({ childId: row.id, parentId })))
        .run();
    return result;
  }

  function query(sessionId: string, filter: LedgerFilter, sources: readonly LedgerSource[] | undefined): LedgerEntry[] {
    const conditions: SQL[] = [eq(ledgerEntries.sessionId, sessionId)];
    if (sources) conditions.push(inArray(ledgerEntries.source, [...sources]));
    if (filter.kinds) conditions.push(inArray(ledgerEntries.kind, [...filter.kinds]));
    if (filter.afterSequence !== undefined) conditions.push(gt(ledgerEntries.sequence, filter.afterSequence));
    const q = db
      .select()
      .from(ledgerEntries)
      .where(and(...conditions))
      .orderBy(asc(ledgerEntries.sequence));
    return (filter.limit === undefined ? q.all() : q.limit(filter.limit).all()).map(toEntry);
  }

  /** Entries whose id is produced by `ids` (a single-column SELECT), in ledger order. */
  function entriesWhereIdIn(ids: SQL): LedgerEntry[] {
    return db
      .select()
      .from(ledgerEntries)
      .where(sql`${ledgerEntries.id} IN (${ids})`)
      .orderBy(asc(ledgerEntries.receivedAt), asc(ledgerEntries.sessionId), asc(ledgerEntries.sequence))
      .all()
      .map(toEntry);
  }

  return {
    createSession(input: { id?: string } = {}): Session {
      const id = input.id ?? newId();
      if (!IdSchema.safeParse(id).success) throw invalid("invalid session id");
      return db.transaction(
        (tx) => {
          if (sessionRow(tx, id)) throw new LedgerError("session_exists", `session ${id} already exists`);
          return toSession(tx.insert(sessions).values({ id, createdAt: now() }).returning().get(), false);
        },
        { behavior: "immediate" },
      );
    },

    getSession(id: string): Session | undefined {
      const row = sessionRow(db, id);
      return row && toSession(row, isArchived(db, id));
    },

    append(entry: NewLedgerEntry): LedgerEntry {
      const prepared = prepare(entry);
      return db.transaction((tx) => insert(tx, prepared), { behavior: "immediate" });
    },

    /** Appends all entries in order, or none of them. */
    appendMany(entries: readonly NewLedgerEntry[]): LedgerEntry[] {
      const prepared = entries.map(prepare);
      return db.transaction((tx) => prepared.map((p) => insert(tx, p)), { behavior: "immediate" });
    },

    /**
     * Goes off the record (or resumes). Each transition starts a new privacy epoch, so capture
     * stamped with an earlier epoch is refused, and is itself recorded as a `system_control` entry.
     */
    setOffRecord(sessionId: string, offRecord: boolean, meta: PrivacyTransitionMeta): LedgerEntry {
      const parsedMeta = PrivacyTransitionMetaSchema.safeParse(meta);
      if (!parsedMeta.success) throw invalid(`invalid privacy transition: ${z.prettifyError(parsedMeta.error)}`);
      const { occurredAt, traceId } = parsedMeta.data;
      return db.transaction(
        (tx) => {
          const session = sessionRow(tx, sessionId);
          if (!session) throw new LedgerError("session_not_found", `session ${sessionId} not found`);
          if (session.offRecord === offRecord)
            throw new LedgerError("state_unchanged", `session ${sessionId} is already ${offRecord ? "off" : "on"} the record`);
          const privacyEpoch = session.privacyEpoch + 1;
          tx.update(sessions).set({ privacyEpoch, offRecord }).where(eq(sessions.id, sessionId)).run();
          return insert(
            tx,
            prepare({
              sessionId,
              source: "system_control",
              kind: offRecord ? "privacy.off_record" : "privacy.on_record",
              occurredAt,
              traceId,
              parentIds: [],
              schemaVersion: PRIVACY_CONTROL_SCHEMA_VERSION,
              privacyEpoch,
              payload: { offRecord, privacyEpoch },
            }),
          );
        },
        { behavior: "immediate" },
      );
    },

    /**
     * Archives the session (session lifecycle): appends its `engine` / `session.archived` entry, after
     * which every append to the session is refused (`session_archived`), this one included. The ledger
     * stays append-only — archiving is an entry, not a change to any recorded entry — and every read
     * keeps working.
     */
    archive(sessionId: string, meta: ArchiveMeta): LedgerEntry {
      const { occurredAt, traceId, ...payload } = meta;
      const parsedMeta = PrivacyTransitionMetaSchema.safeParse({ occurredAt, traceId });
      if (!parsedMeta.success) throw invalid(`invalid archive request: ${z.prettifyError(parsedMeta.error)}`);
      const parsedPayload = ledgerPayloadSchema(SESSION_ARCHIVED_KIND).safeParse(payload);
      if (!parsedPayload.success) throw invalid(`invalid archive request: ${z.prettifyError(parsedPayload.error)}`);
      return db.transaction(
        (tx) => {
          const session = sessionRow(tx, sessionId);
          if (!session) throw new LedgerError("session_not_found", `session ${sessionId} not found`);
          return insert(
            tx,
            prepare({
              sessionId,
              source: "engine",
              kind: SESSION_ARCHIVED_KIND,
              occurredAt: parsedMeta.data.occurredAt,
              traceId: parsedMeta.data.traceId,
              parentIds: [],
              schemaVersion: SESSION_ARCHIVED_SCHEMA_VERSION,
              privacyEpoch: session.privacyEpoch,
              payload: parsedPayload.data,
            }),
          );
        },
        { behavior: "immediate" },
      );
    },

    get(id: string): LedgerEntry | undefined {
      const row = db.select().from(ledgerEntries).where(eq(ledgerEntries.id, id)).get();
      return row && toEntry(row);
    },

    /** Entries of one session in sequence order. */
    list(sessionId: string, filter: LedgerFilter = {}): LedgerEntry[] {
      return query(sessionId, filter, filter.sources);
    },

    /** Like `list`, but never returns `system_control` entries, whatever the filter. */
    evidence(sessionId: string, filter: LedgerFilter = {}): LedgerEntry[] {
      const sources = (filter.sources ?? LEDGER_SOURCES).filter((source) => isEvidenceEligible({ source }));
      return query(sessionId, filter, sources);
    },

    parents(id: string): LedgerEntry[] {
      return entriesWhereIdIn(sql`SELECT parent_id FROM ledger_edges WHERE child_id = ${id}`);
    },

    children(id: string): LedgerEntry[] {
      return entriesWhereIdIn(sql`SELECT child_id FROM ledger_edges WHERE parent_id = ${id}`);
    },

    /** All transitive parents, each once (excluding the entry itself). */
    ancestors(id: string): LedgerEntry[] {
      return entriesWhereIdIn(sql`
        WITH RECURSIVE walk(id) AS (
          SELECT parent_id FROM ledger_edges WHERE child_id = ${id}
          UNION
          SELECT e.parent_id FROM ledger_edges e JOIN walk ON e.child_id = walk.id
        )
        SELECT id FROM walk`);
    },

    /** All transitive children, each once (excluding the entry itself). */
    descendants(id: string): LedgerEntry[] {
      return entriesWhereIdIn(sql`
        WITH RECURSIVE walk(id) AS (
          SELECT child_id FROM ledger_edges WHERE parent_id = ${id}
          UNION
          SELECT e.child_id FROM ledger_edges e JOIN walk ON e.parent_id = walk.id
        )
        SELECT id FROM walk`);
    },
  };
}

export type Ledger = ReturnType<typeof createLedger>;
