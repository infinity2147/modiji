/**
 * The confirmed rulebook in force (plan §6.4): `rulebookFromLedger` over the `rule.*` entries of every
 * expert session, in ledger order across sessions. Only `runtime-init.ts` and test harnesses import this
 * module: it reads SQLite directly, which route bundles must never load.
 *
 * With two experts (plan §7.10) the same store also gives the expert directory (who has expert
 * sessions, latest first per expert), the open disagreement holds and the team rulebook
 * (`teamRulebook`, see packages/core/src/engine/team.ts for the exact semantics).
 *
 * Every view is an incremental fold over the append-only ledger (`incrementalFold`): it remembers the
 * last row id it folded and, after an append, reads only the newer rows of its kinds (indexed by
 * `ledger_entries_kind_idx`), never the whole table. The result is exactly the fold of all rows in the
 * view's order: rows that sort before rows already folded (equal or older `received_at`), or rows of a
 * session that only now became an expert session, refold the rows held in memory from the start.
 */
import "server-only";
import {
  RULE_EVENT_KINDS,
  WitnessResolutionSchema,
  WitnessSchema,
  createRulebookFold,
  teamRulebook,
  type DisagreementHold,
  type LedgerSource,
  type Rulebook,
  type TeamRulebook,
} from "@vashistha/core";
import type { OpenedDatabase } from "@vashistha/core/server";
import { SessionStartedPayloadSchema, sessionExpert, type SessionExpert } from "../casedesk/session";

type Sqlite = OpenedDatabase["sqlite"];

/** The columns every fold reads: the row id (append order) and the session. */
type Positioned = { rowid: number; session_id: string };

/** A resumable fold: `add` rows in the view's order; `value` is the view so far (a fresh object). */
type Fold<R, T> = { add: (row: R) => void; value: () => T };

type FoldSpec<R extends Positioned, T> = {
  /** The view's rows with `after < rowid <= upTo`. */
  rowsAfter: (after: number, upTo: number) => R[];
  /** The view's order (a total order over its rows). */
  order: (a: R, b: R) => number;
  start: () => Fold<R, T>;
  /**
   * Folds over expert sessions only: the view's rows of one session with `rowid <= upTo`, read when
   * the session becomes an expert session after some of its rows were already appended.
   */
  rowsOfSession?: (sessionId: string, upTo: number) => R[];
};

const EXPERT_SESSION_STARTED = `kind = 'session.started' AND source = 'engine' AND json_extract(payload, '$.mode') = 'expert'`;

/** SQLite's BINARY collation: compares the UTF-8 bytes (JavaScript's `<` compares UTF-16 code units). */
function compareText(a: string, b: string): number {
  return a === b ? 0 : Buffer.compare(Buffer.from(a, "utf8"), Buffer.from(b, "utf8"));
}

/** The sessions with an expert `session.started` entry, grown as the ledger is. */
function expertSessions(sqlite: Sqlite): { ids: Set<string>; advance: (after: number, upTo: number) => string[] } {
  const started = sqlite.prepare<[number, number], { session_id: string }>(
    `SELECT session_id FROM ledger_entries WHERE ${EXPERT_SESSION_STARTED} AND rowid > ? AND rowid <= ? ORDER BY rowid`,
  );
  const ids = new Set<string>();
  return {
    ids,
    /** Adds the expert sessions started in `(after, upTo]`; returns the ones that are new. */
    advance(after, upTo) {
      const added: string[] = [];
      for (const { session_id } of started.all(after, upTo))
        if (!ids.has(session_id)) {
          ids.add(session_id);
          added.push(session_id);
        }
      return added;
    },
  };
}

/**
 * A view over the ledger, recomputed only after an append (the latest row id is the cache key; the
 * ledger is append-only) and then only from the rows appended since: the same object while nothing
 * the view reads has changed.
 */
function incrementalFold<R extends Positioned, T>(sqlite: Sqlite, spec: FoldSpec<R, T>): () => T {
  const latest = sqlite.prepare<[], { latest: number | null }>("SELECT max(rowid) AS latest FROM ledger_entries");
  const experts = spec.rowsOfSession === undefined ? undefined : expertSessions(sqlite);
  let folded = 0;
  let rows: R[] = [];
  let fold = spec.start();
  let value = fold.value();
  return () => {
    const upTo = latest.get()?.latest ?? 0;
    if (upTo === folded) return value;
    const after = folded;
    folded = upTo;
    const becameExpert = experts?.advance(after, upTo) ?? [];
    const fresh = spec.rowsAfter(after, upTo).filter((r) => experts === undefined || experts.ids.has(r.session_id));
    const earlier = becameExpert.flatMap((id) => spec.rowsOfSession?.(id, after) ?? []);
    if (fresh.length === 0 && earlier.length === 0) return value;
    fresh.sort(spec.order);
    const [first] = fresh;
    const tail = rows.at(-1);
    if (earlier.length === 0 && first !== undefined && (tail === undefined || spec.order(tail, first) < 0)) {
      // The common case: everything new sorts after everything folded.
      rows.push(...fresh);
      for (const r of fresh) fold.add(r);
    } else {
      rows = [...rows, ...earlier, ...fresh].sort(spec.order);
      fold = spec.start();
      for (const r of rows) fold.add(r);
    }
    value = fold.value();
    return value;
  };
}

type RuleRow = Positioned & { id: string; source: LedgerSource; kind: string; received_at: number; sequence: number; payload: string };

const RULE_KINDS = Object.values(RULE_EVENT_KINDS);
const RULE_COLUMNS = "rowid, id, session_id, source, kind, received_at, sequence, payload";
const RULE_KIND_IN = `kind IN (${RULE_KINDS.map(() => "?").join(", ")})`;

export function createLedgerRulebook(sqlite: Sqlite): () => Rulebook {
  const after = sqlite.prepare<[...string[], number, number], RuleRow>(`SELECT ${RULE_COLUMNS} FROM ledger_entries WHERE ${RULE_KIND_IN} AND rowid > ? AND rowid <= ?`);
  const ofSession = sqlite.prepare<[string, ...string[], number], RuleRow>(`SELECT ${RULE_COLUMNS} FROM ledger_entries WHERE session_id = ? AND ${RULE_KIND_IN} AND rowid <= ?`);
  return incrementalFold<RuleRow, Rulebook>(sqlite, {
    rowsAfter: (from, upTo) => after.all(...RULE_KINDS, from, upTo),
    rowsOfSession: (sessionId, upTo) => ofSession.all(sessionId, ...RULE_KINDS, upTo),
    // Ledger order across sessions.
    order: (a, b) => a.received_at - b.received_at || compareText(a.session_id, b.session_id) || a.sequence - b.sequence,
    start: () => {
      const fold = createRulebookFold();
      return {
        add: (r) => fold.apply({ id: r.id, source: r.source, kind: r.kind, payload: JSON.parse(r.payload) as unknown }),
        value: fold.rulebook,
      };
    },
  });
}

/** An expert and their capture sessions, oldest first (`sessionIds.at(-1)` is the latest). */
export type ExpertRecord = SessionExpert & { sessionIds: string[] };

type StartedRow = Positioned & { received_at: number; payload: string };

/** Every expert with an expert capture session, in order of their first session. */
export function createExpertDirectory(sqlite: Sqlite): () => ExpertRecord[] {
  const started = sqlite.prepare<[number, number], StartedRow>(
    `SELECT rowid, session_id, received_at, payload FROM ledger_entries WHERE ${EXPERT_SESSION_STARTED} AND rowid > ? AND rowid <= ?`,
  );
  return incrementalFold<StartedRow, ExpertRecord[]>(sqlite, {
    rowsAfter: (from, upTo) => started.all(from, upTo),
    order: (a, b) => a.received_at - b.received_at || compareText(a.session_id, b.session_id) || a.rowid - b.rowid,
    start: () => {
      const experts = new Map<string, ExpertRecord>();
      return {
        add(row) {
          const payload = SessionStartedPayloadSchema.safeParse(JSON.parse(row.payload));
          if (!payload.success) return;
          const expert = sessionExpert(row.session_id, payload.data.mode, payload.data.expert);
          if (expert === undefined) return;
          const known = experts.get(expert.id);
          if (known === undefined) experts.set(expert.id, { ...expert, sessionIds: [row.session_id] });
          // The latest session states the expert's current name and language.
          else experts.set(expert.id, { ...expert, sessionIds: [...known.sessionIds, row.session_id] });
        },
        value: () => [...experts.values()],
      };
    },
  });
}

type WitnessRow = Positioned & { kind: string; payload: string };

const WITNESS_ROWS = `((kind = 'witness.found' AND source = 'solver' AND json_extract(payload, '$.kind') = 'disagreement')
  OR (kind = 'witness.resolved' AND source = 'engine'))`;

/**
 * Open disagreements (plan §7.10): disagreement witnesses recorded by the solver (`witness.found`, in
 * an expert session) with no `witness.resolved` for their id yet. A witness recorded in both experts'
 * sessions counts once.
 */
export function createDisagreementHolds(sqlite: Sqlite): () => DisagreementHold[] {
  const after = sqlite.prepare<[number, number], WitnessRow>(`SELECT rowid, session_id, kind, payload FROM ledger_entries WHERE ${WITNESS_ROWS} AND rowid > ? AND rowid <= ?`);
  const ofSession = sqlite.prepare<[string, number], WitnessRow>(`SELECT rowid, session_id, kind, payload FROM ledger_entries WHERE session_id = ? AND ${WITNESS_ROWS} AND rowid <= ?`);
  return incrementalFold<WitnessRow, DisagreementHold[]>(sqlite, {
    rowsAfter: (from, upTo) => after.all(from, upTo),
    rowsOfSession: (sessionId, upTo) => ofSession.all(sessionId, upTo),
    // In append order (rowid): a disagreement found again after a resolution is open again.
    order: (a, b) => a.rowid - b.rowid,
    start: () => {
      const open = new Map<string, DisagreementHold>();
      return {
        add(row) {
          const payload = JSON.parse(row.payload) as unknown;
          if (row.kind === "witness.resolved") {
            const r = WitnessResolutionSchema.safeParse(payload);
            if (r.success) open.delete(r.data.witnessId);
            return;
          }
          const w = WitnessSchema.safeParse(payload);
          if (w.success && w.data.kind === "disagreement")
            open.set(w.data.id, { witnessId: w.data.id, decisionFamily: w.data.decisionFamily, experts: w.data.experts, assignment: w.data.assignment });
        },
        value: () => [...open.values()],
      };
    },
  });
}

/** The team rulebook over `all`, holding back what open disagreements hold; the same object while its inputs are. */
export function teamRulebookView(all: () => Rulebook, holds: () => DisagreementHold[]): () => TeamRulebook {
  let last: { book: Rulebook; holds: DisagreementHold[]; team: TeamRulebook } | undefined;
  return () => {
    const book = all();
    const open = holds();
    if (last?.book !== book || last.holds !== open) last = { book, holds: open, team: teamRulebook(book, open) };
    return last.team;
  };
}
