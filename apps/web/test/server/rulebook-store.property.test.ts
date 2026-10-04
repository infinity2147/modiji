/**
 * The incremental rulebook store (rulebook-store.ts) against the full fold it replaced: over random
 * append sequences — rule events of every kind and source (valid and invalid), sessions that become
 * expert sessions after their rule rows were appended, disagreement witnesses found and resolved,
 * noise rows, received_at ties and clocks going backwards, session ids whose UTF-8 and UTF-16 orders
 * differ — every read of the incremental rulebook, expert directory and disagreement holds equals the
 * full-scan fold of the whole ledger at that point.
 */
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import {
  RULE_EVENT_KINDS,
  WitnessResolutionSchema,
  WitnessSchema,
  rulebookFromLedger,
  type DisagreementHold,
  type LedgerSource,
  type Rulebook,
} from "@vashistha/core";
import { KYC_DOMAIN } from "@vashistha/core/domains/kyc";
import { openDatabase, type OpenedDatabase } from "@vashistha/core/server";
import { SessionStartedPayloadSchema, sessionExpert } from "../../lib/server/casedesk/session";
import { createDisagreementHolds, createExpertDirectory, createLedgerRulebook, type ExpertRecord } from "../../lib/server/debrief/rulebook-store";

type Sqlite = OpenedDatabase["sqlite"];

// ---- The full fold, as the store computed it before it was incremental (the specification) ----

const EXPERT_SESSIONS = `SELECT s.session_id FROM ledger_entries s
  WHERE s.kind = 'session.started' AND s.source = 'engine' AND json_extract(s.payload, '$.mode') = 'expert'`;
const KINDS = Object.values(RULE_EVENT_KINDS);

function fullRulebook(sqlite: Sqlite): Rulebook {
  const rows = sqlite
    .prepare<string[], { id: string; source: LedgerSource; kind: string; payload: string }>(
      `SELECT e.id, e.source, e.kind, e.payload FROM ledger_entries e
       WHERE e.kind IN (${KINDS.map(() => "?").join(", ")}) AND e.session_id IN (${EXPERT_SESSIONS})
       ORDER BY e.received_at, e.session_id, e.sequence`,
    )
    .all(...KINDS);
  return rulebookFromLedger(rows.map((r) => ({ id: r.id, source: r.source, kind: r.kind, payload: JSON.parse(r.payload) as unknown })));
}

function fullDirectory(sqlite: Sqlite): ExpertRecord[] {
  // `rowid` only orders two session.started rows of one session at the same instant, which the original left unspecified.
  const rows = sqlite
    .prepare<[], { session_id: string; payload: string }>(
      `SELECT session_id, payload FROM ledger_entries
       WHERE kind = 'session.started' AND source = 'engine' AND json_extract(payload, '$.mode') = 'expert'
       ORDER BY received_at, session_id, rowid`,
    )
    .all();
  const experts = new Map<string, ExpertRecord>();
  for (const row of rows) {
    const payload = SessionStartedPayloadSchema.safeParse(JSON.parse(row.payload));
    if (!payload.success) continue;
    const expert = sessionExpert(row.session_id, payload.data.mode, payload.data.expert);
    if (expert === undefined) continue;
    const known = experts.get(expert.id);
    experts.set(expert.id, { ...expert, sessionIds: [...(known?.sessionIds ?? []), row.session_id] });
  }
  return [...experts.values()];
}

function fullHolds(sqlite: Sqlite): DisagreementHold[] {
  const rows = sqlite
    .prepare<[], { kind: string; payload: string }>(
      `SELECT kind, payload FROM ledger_entries
       WHERE ((kind = 'witness.found' AND source = 'solver' AND json_extract(payload, '$.kind') = 'disagreement')
          OR (kind = 'witness.resolved' AND source = 'engine'))
         AND session_id IN (${EXPERT_SESSIONS})
       ORDER BY rowid`,
    )
    .all();
  const open = new Map<string, DisagreementHold>();
  for (const row of rows) {
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
}

// ---- Random append sequences ----

/** "￿" sorts before "\u{1F600}" in UTF-8 (SQLite) but after it in UTF-16 (JavaScript `<`). */
const SESSIONS = ["s-b", "s-a", "s-\uFFFF", "s-\u{1F600}"] as const;
const EXPERTS = ["asha", "priya"] as const;

function rule(id: string, revision: number, expertId: string): Record<string, unknown> {
  return {
    id,
    decisionFamily: "reviewOutcome",
    kind: "decision",
    predicate: { "==": [{ var: "jurisdictionRisk" }, "high"] },
    effect: { type: "recommend", action: "enhancedReview" },
    priority: 10,
    overrides: [],
    evidence: [{ kind: "expert_quote", utteranceId: `u-${id}`, exactQuote: `quote ${id}`, t0Ms: 0, t1Ms: 1, frameIds: [`f-${id}`], eventIds: [], relation: "supports", provenance: "human_voice" }],
    confirmedBy: [{ expertId, at: 1, method: "explicit_statement", ledgerEntryId: `u-${id}` }],
    revision,
    schemaVersion: 1,
    expertId,
  };
}

type Row = { source: string; kind: string; payload: unknown };

const sessionArb = fc.constantFrom(...SESSIONS);
const ruleIdArb = fc.constantFrom("r0", "r1");
const witnessIdArb = fc.constantFrom("w0", "w1", "w2");
const expertArb = fc.constantFrom(...EXPERTS);

const rowArb: fc.Arbitrary<Row> = fc.oneof(
  {
    weight: 2,
    arbitrary: fc.record({ mode: fc.constantFrom("expert", "novice"), expert: fc.option(expertArb, { nil: undefined }), valid: fc.boolean() }).map(({ mode, expert, valid }) => ({
      source: "engine",
      kind: "session.started",
      payload: valid
        ? { mode, caseSet: "training", domainId: KYC_DOMAIN.id, schemaVersion: 1, ...(expert !== undefined && { expert: { id: expert, name: expert.toUpperCase(), language: "en" } }) }
        : { mode },
    })),
  },
  {
    weight: 5,
    arbitrary: fc
      .record({ kind: fc.constantFrom(...KINDS), id: ruleIdArb, revision: fc.constantFrom(1, 1, 2, 3), expert: expertArb, source: fc.constantFrom("engine", "engine", "expert", "client") })
      .map(({ kind, id, revision, expert, source }) => ({
        source,
        kind,
        payload:
          kind === RULE_EVENT_KINDS.confirmed
            ? { rule: rule(id, revision, expert) }
            : kind === RULE_EVENT_KINDS.revised
              ? { rule: rule(id, revision, expert), reason: "restated" }
              : { ruleId: id, reason: "withdrawn" },
      })),
  },
  {
    weight: 3,
    arbitrary: fc.record({ id: witnessIdArb, source: fc.constantFrom("solver", "solver", "engine"), disagreement: fc.boolean() }).map(({ id, source, disagreement }) => ({
      source,
      kind: "witness.found",
      payload: disagreement
        ? { id, kind: "disagreement", decisionFamily: "reviewOutcome", assignment: { jurisdictionRisk: "high" }, schemaVersion: 1, experts: ["asha", "priya"], actions: ["approve", "enhancedReview"] }
        : { id, kind: "unresolved", decisionFamily: "reviewOutcome", assignment: { jurisdictionRisk: "low" }, schemaVersion: 1 },
    })),
  },
  {
    weight: 2,
    arbitrary: fc.record({ id: witnessIdArb, source: fc.constantFrom("engine", "engine", "solver") }).map(({ id, source }) => ({
      source,
      kind: "witness.resolved",
      payload: { witnessId: id, resolution: "rule_revised", ledgerEntryId: "e-x" },
    })),
  },
  { weight: 2, arbitrary: fc.constant({ source: "client", kind: "frame.received", payload: { ok: true } }) },
);

/** An append (in a session, received `dt` ms after the previous one: ties and clock steps backwards included) or a read of every view. */
type Op = { type: "append"; session: string; dt: number; row: Row } | { type: "read" };

const opArb: fc.Arbitrary<Op> = fc.oneof(
  { weight: 5, arbitrary: fc.record({ type: fc.constant("append" as const), session: sessionArb, dt: fc.constantFrom(-2, -1, 0, 0, 0, 1, 3), row: rowArb }) },
  { weight: 1, arbitrary: fc.constant({ type: "read" as const }) },
);

/** Raw inserts (as the replay's scratch database does): any row the table can hold, at any received_at. */
function rawLedger(sqlite: Sqlite) {
  const insertSession = sqlite.prepare("INSERT INTO sessions (id, created_at) VALUES (?, 0)");
  const insertEntry = sqlite.prepare(
    `INSERT INTO ledger_entries (id, session_id, sequence, source, kind, occurred_at, received_at, trace_id, parent_ids, schema_version, privacy_epoch, payload)
     VALUES (?, ?, ?, ?, ?, 0, ?, 't', '[]', 1, 0, ?)`,
  );
  const sequences = new Map<string, number>();
  let clock = 1_000;
  let n = 0;
  return (session: string, dt: number, row: Row): void => {
    const sequence = sequences.get(session) ?? 0;
    if (sequence === 0) insertSession.run(session);
    sequences.set(session, sequence + 1);
    clock = Math.max(0, clock + dt);
    n += 1;
    insertEntry.run(`e${n}`, session, sequence, row.source, row.kind, clock, JSON.stringify(row.payload));
  };
}

describe("incremental rulebook store", () => {
  it("equals the full fold after every append sequence, at every read", () => {
    fc.assert(
      // Some sessions start as expert sessions; the others may become one (or not) during the sequence.
      fc.property(fc.subarray([...SESSIONS]), fc.array(opArb, { maxLength: 80 }), (experts, ops) => {
        const opened = openDatabase({ memory: true });
        try {
          const { sqlite } = opened;
          const append = rawLedger(sqlite);
          for (const session of experts) append(session, 0, { source: "engine", kind: "session.started", payload: { mode: "expert" } });
          const views = { rulebook: createLedgerRulebook(sqlite), directory: createExpertDirectory(sqlite), holds: createDisagreementHolds(sqlite) };
          const check = (): void => {
            expect(views.rulebook()).toEqual(fullRulebook(sqlite));
            expect(views.directory()).toEqual(fullDirectory(sqlite));
            expect(views.holds()).toEqual(fullHolds(sqlite));
          };
          for (const op of ops) {
            if (op.type === "read") check();
            else append(op.session, op.dt, op.row);
          }
          check();
        } finally {
          opened.close();
        }
      }),
      { seed: 20261004, numRuns: 1000 },
    );
  });

  it("returns the same object while no row it reads was appended, and never changes a value it returned", () => {
    const opened = openDatabase({ memory: true });
    const append = rawLedger(opened.sqlite);
    const rulebook = createLedgerRulebook(opened.sqlite);
    append("s-a", 1, { source: "engine", kind: "session.started", payload: { mode: "expert", caseSet: "training", domainId: KYC_DOMAIN.id, schemaVersion: 1 } });
    append("s-a", 1, { source: "engine", kind: RULE_EVENT_KINDS.confirmed, payload: { rule: rule("r0", 1, "asha") } });
    const first = rulebook();
    expect(first.revision).toBe(1);
    append("s-a", 1, { source: "client", kind: "frame.received", payload: { ok: true } });
    expect(rulebook()).toBe(first);
    append("s-a", 1, { source: "engine", kind: RULE_EVENT_KINDS.revised, payload: { rule: rule("r0", 2, "asha"), reason: "restated" } });
    const second = rulebook();
    expect(second.revision).toBe(2);
    expect(first.history).toHaveLength(1);
    expect(first.rules[0]?.revision).toBe(1);
    opened.close();
  });
});
