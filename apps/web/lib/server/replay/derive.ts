/**
 * Server views of a recorded run at any point of its timeline, derived by THE SAME code the live
 * routes run — `snapshot`/`debriefState` (debrief, coverage), `readOnlyWorkMap` (Work Map), `tutorState`
 * (tutor) — over a scratch in-memory SQLite holding exactly the first n entries of the bundle, with
 * the rulebook folded by the same store functions the runtime composes (runtime-init.ts). Nothing is
 * synthesised: the scratch database holds the bundle's entries verbatim (ids, sequences, times).
 *
 * Read-only by construction: the ledger handed to the derivations refuses every write, there is no
 * model client (`claude: null`), and the Work Map never writes a file. Z3 runs as it does live (it is
 * deterministic code, not a model).
 */
import "server-only";
import { engineConfig, type LedgerEntry } from "@vashistha/core";
import { CLAUDE_MODELS, createLedger, openDatabase, type Ledger, type OpenedDatabase } from "@vashistha/core/server";
import { KYC_DOMAIN } from "@vashistha/core/domains/kyc";
import type { ReplaySessionViews } from "../../contracts/replay";
import type { BundleSession } from "../../replay/format";
import { createAuthorizationStore } from "../authorizations";
import { createCaseDeskStore } from "../casedesk/session";
import { type DebriefDeps, type DebriefExports, type DebriefStore } from "../debrief/deps";
import { createDisagreementHolds, createLedgerRulebook, teamRulebookView } from "../debrief/rulebook-store";
import type { WitnessSolver } from "../debrief/solver";
import { debriefState, snapshot } from "../debrief/state";
import { readOnlyWorkMap } from "../debrief/workmap";
import { createInterviewStore } from "../interview/engine-state";
import { rulebookViewWithinModel } from "../schema/rulebook";
import type { TutorDeps } from "../tutor/deps";
import { tutorState } from "../tutor/handlers";
import { loadNoviceSession } from "../tutor/session";

export type ReplayEngines = { solver: WitnessSolver; exports: DebriefExports };

const QUIET = { info: () => undefined, warn: () => undefined, error: (...a: unknown[]) => console.error("[replay]", ...a) };

function refuse(): never {
  throw new Error("verified replay is read-only: nothing is written to any ledger");
}

/** The ledger interface over the scratch database, with every write refused. */
function readOnly(ledger: Ledger): Ledger {
  return { ...ledger, createSession: refuse, append: refuse, appendMany: refuse, setOffRecord: refuse };
}

/** A scratch database holding the first `n` timeline entries, grown in place as the replay moves forward. */
export type Prefix = {
  n: number;
  opened: OpenedDatabase;
  debrief: DebriefDeps;
  tutor: TutorDeps;
  insert: (entries: readonly LedgerEntry[]) => void;
};

export function createPrefix(engines: ReplayEngines, store: DebriefStore, now: number): Prefix {
  const opened = openDatabase({ memory: true });
  const { sqlite } = opened;
  const ledger = readOnly(createLedger(opened.db));
  const insertSession = sqlite.prepare("INSERT INTO sessions (id, created_at, privacy_epoch, off_record, next_sequence) VALUES (?, ?, 0, 0, 0)");
  const advanceSession = sqlite.prepare(
    "UPDATE sessions SET next_sequence = ?, privacy_epoch = max(privacy_epoch, ?), off_record = coalesce(?, off_record) WHERE id = ?",
  );
  const insertEntry = sqlite.prepare(
    `INSERT INTO ledger_entries (id, session_id, sequence, source, kind, occurred_at, received_at, trace_id, parent_ids, schema_version, privacy_epoch, payload)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  const insertEdge = sqlite.prepare("INSERT OR IGNORE INTO ledger_edges (child_id, parent_id) VALUES (?, ?)");
  const known = new Set<string>();
  const sessions = new Set<string>();
  /** Edges whose parent is later in the timeline (equal receivedAt across sessions): inserted when it arrives. */
  const pending = new Map<string, string[]>();

  const insert = sqlite.transaction((entries: readonly LedgerEntry[]) => {
    for (const e of entries) {
      if (!sessions.has(e.sessionId)) {
        insertSession.run(e.sessionId, e.receivedAt);
        sessions.add(e.sessionId);
      }
      insertEntry.run(e.id, e.sessionId, e.sequence, e.source, e.kind, e.occurredAt, e.receivedAt, e.traceId, JSON.stringify(e.parentIds), e.schemaVersion, e.privacyEpoch, JSON.stringify(e.payload));
      const offRecord = e.kind === "privacy.off_record" ? 1 : e.kind === "privacy.on_record" ? 0 : null;
      advanceSession.run(e.sequence + 1, e.privacyEpoch, offRecord, e.sessionId);
      known.add(e.id);
      for (const parent of new Set(e.parentIds)) {
        if (known.has(parent)) insertEdge.run(e.id, parent);
        else pending.set(parent, [...(pending.get(parent) ?? []), e.id]);
      }
      for (const child of pending.get(e.id) ?? []) insertEdge.run(child, e.id);
      pending.delete(e.id);
    }
  });

  // The rulebook as the runtime composes it (runtime-init.ts): every expert session's rule events, the
  // team view (open disagreements hold decision rules back), narrowed to the base feature model for the tutor.
  const rulebookAllModels = createLedgerRulebook(sqlite);
  const rulebookState = rulebookViewWithinModel(KYC_DOMAIN, teamRulebookView(rulebookAllModels, createDisagreementHolds(sqlite)));
  const casedesk = createCaseDeskStore();
  const authorizations = createAuthorizationStore();
  const debrief: DebriefDeps = {
    ledger,
    casedesk,
    interview: createInterviewStore(),
    engineConfig: engineConfig(),
    authorizations,
    rulebook: rulebookAllModels,
    solver: engines.solver,
    claude: null,
    models: { prose: CLAUDE_MODELS.prose },
    exports: engines.exports,
    store,
    // Never read: the read-only Work Map neither reads nor writes saved exports.
    dataDir: "/nonexistent-replay-data-dir",
    mcpBearerRequired: true,
    now: () => now,
    log: QUIET,
  };
  const tutor: TutorDeps = {
    ledger,
    casedesk,
    rulebook: rulebookState,
    authorizations,
    practice: () => Promise.reject(new Error("verified replay is read-only: no practice cases are generated")),
    now: () => now,
    log: QUIET,
  };
  const prefix: Prefix = {
    n: 0,
    opened,
    debrief,
    tutor,
    insert: (entries) => {
      insert(entries);
      prefix.n += entries.length;
    },
  };
  return prefix;
}

const describe = (error: unknown): string => (error instanceof Error ? error.message : String(error));

/** Every bundled session's server views over the prefix (sessions not started yet get a note). */
export async function deriveViews(prefix: Prefix, sessions: readonly BundleSession[]): Promise<Record<string, ReplaySessionViews>> {
  const out: Record<string, ReplaySessionViews> = {};
  for (const s of sessions) {
    const empty: ReplaySessionViews = { debrief: null, workmap: null, tutor: null, note: null };
    if (prefix.debrief.ledger.getSession(s.id) === undefined) {
      out[s.id] = { ...empty, note: "This session had not started at this point of the recording." };
      continue;
    }
    try {
      if (s.mode === "expert") {
        const snap = await snapshot(prefix.debrief, s.id);
        out[s.id] = { ...empty, debrief: debriefState(prefix.debrief, snap), workmap: await readOnlyWorkMap(prefix.debrief, s.id) };
      } else {
        out[s.id] = { ...empty, tutor: tutorState(prefix.tutor, loadNoviceSession(prefix.tutor, s.id)) };
      }
    } catch (error) {
      out[s.id] = { ...empty, note: `Could not derive this session's view: ${describe(error)}` };
    }
  }
  return out;
}
