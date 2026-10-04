/**
 * The confirmed rulebook in force (plan §6.4): `rulebookFromLedger` over the `rule.*` entries of every
 * expert session, in ledger order across sessions. Recomputed only when the ledger has grown (the
 * latest row id is the cache key; the ledger is append-only). Only `runtime-init.ts` and test
 * harnesses import this module: it reads SQLite directly, which route bundles must never load.
 *
 * With two experts (plan §7.10) the same store also gives the expert directory (who has expert
 * sessions, latest first per expert), the open disagreement holds and the team rulebook
 * (`teamRulebook`, see packages/core/src/engine/team.ts for the exact semantics).
 */
import "server-only";
import {
  RULE_EVENT_KINDS,
  WitnessResolutionSchema,
  WitnessSchema,
  rulebookFromLedger,
  teamRulebook,
  type DisagreementHold,
  type LedgerSource,
  type Rulebook,
  type TeamRulebook,
} from "@vashistha/core";
import type { OpenedDatabase } from "@vashistha/core/server";
import { SessionStartedPayloadSchema, sessionExpert, type SessionExpert } from "../casedesk/session";

type Row = { id: string; source: LedgerSource; kind: string; payload: string };

const KINDS = Object.values(RULE_EVENT_KINDS);

const EXPERT_SESSIONS = `SELECT s.session_id FROM ledger_entries s
  WHERE s.kind = 'session.started' AND s.source = 'engine' AND json_extract(s.payload, '$.mode') = 'expert'`;

/** A memo over the ledger's latest row id: `compute` runs again only after an append. */
function memoOnLedger<T>(sqlite: OpenedDatabase["sqlite"], compute: () => T): () => T {
  const latest = sqlite.prepare<[], { latest: number | null }>("SELECT max(rowid) AS latest FROM ledger_entries");
  let cached: { key: number; value: T } | undefined;
  return () => {
    const key = latest.get()?.latest ?? 0;
    if (cached?.key !== key) cached = { key, value: compute() };
    return cached.value;
  };
}

export function createLedgerRulebook(sqlite: OpenedDatabase["sqlite"]): () => Rulebook {
  const ruleEvents = sqlite.prepare<string[], Row>(
    `SELECT e.id, e.source, e.kind, e.payload FROM ledger_entries e
     WHERE e.kind IN (${KINDS.map(() => "?").join(", ")}) AND e.session_id IN (${EXPERT_SESSIONS})
     ORDER BY e.received_at, e.session_id, e.sequence`,
  );
  return memoOnLedger(sqlite, () =>
    rulebookFromLedger(ruleEvents.all(...KINDS).map((r) => ({ id: r.id, source: r.source, kind: r.kind, payload: JSON.parse(r.payload) as unknown }))),
  );
}

/** An expert and their capture sessions, oldest first (`sessionIds.at(-1)` is the latest). */
export type ExpertRecord = SessionExpert & { sessionIds: string[] };

/** Every expert with an expert capture session, in order of their first session. */
export function createExpertDirectory(sqlite: OpenedDatabase["sqlite"]): () => ExpertRecord[] {
  const started = sqlite.prepare<[], { session_id: string; payload: string }>(
    `SELECT session_id, payload FROM ledger_entries
     WHERE kind = 'session.started' AND source = 'engine' AND json_extract(payload, '$.mode') = 'expert'
     ORDER BY received_at, session_id`,
  );
  return memoOnLedger(sqlite, () => {
    const experts = new Map<string, ExpertRecord>();
    for (const row of started.all()) {
      const payload = SessionStartedPayloadSchema.safeParse(JSON.parse(row.payload));
      if (!payload.success) continue;
      const expert = sessionExpert(row.session_id, payload.data.mode, payload.data.expert);
      if (expert === undefined) continue;
      const known = experts.get(expert.id);
      if (known === undefined) experts.set(expert.id, { ...expert, sessionIds: [row.session_id] });
      // The latest session states the expert's current name and language.
      else experts.set(expert.id, { ...expert, sessionIds: [...known.sessionIds, row.session_id] });
    }
    return [...experts.values()];
  });
}

/**
 * Open disagreements (plan §7.10): disagreement witnesses recorded by the solver (`witness.found`, in
 * an expert session) with no `witness.resolved` for their id yet. A witness recorded in both experts'
 * sessions counts once.
 */
export function createDisagreementHolds(sqlite: OpenedDatabase["sqlite"]): () => DisagreementHold[] {
  const rows = sqlite.prepare<[], { kind: string; payload: string }>(
    `SELECT kind, payload FROM ledger_entries
     WHERE ((kind = 'witness.found' AND source = 'solver' AND json_extract(payload, '$.kind') = 'disagreement')
        OR (kind = 'witness.resolved' AND source = 'engine'))
       AND session_id IN (${EXPERT_SESSIONS})
     ORDER BY rowid`,
  );
  return memoOnLedger(sqlite, () => {
    // In append order (rowid): a disagreement found again after a resolution is open again.
    const open = new Map<string, DisagreementHold>();
    for (const row of rows.all()) {
      const payload = JSON.parse(row.payload) as unknown;
      if (row.kind === "witness.resolved") {
        const r = WitnessResolutionSchema.safeParse(payload);
        if (r.success) open.delete(r.data.witnessId);
        continue;
      }
      const w = WitnessSchema.safeParse(payload);
      if (w.success && w.data.kind === "disagreement")
        open.set(w.data.id, { witnessId: w.data.id, decisionFamily: w.data.decisionFamily, experts: w.data.experts, assignment: w.data.assignment });
    }
    return [...open.values()];
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
