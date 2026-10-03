/**
 * CaseDesk sessions. A CaseDesk session is a ledger session whose first entry is `engine` /
 * `session.started`, carrying its mode and case set; that entry is the root every later CaseDesk
 * entry descends from. Session facts are read back from it (no schema change) and cached, which is
 * safe because the ledger is append-only. The live privacy state is always read from the ledger.
 */
import "server-only";
import { z } from "zod";
import { IdSchema, type ActionId, type ConfirmedRule, type FeatureId, type LedgerEntry } from "@vashistha/core";
import type { Ledger, Session } from "@vashistha/core/server";
import { CaseSetSchema, KYC_DOMAIN, type CaseSet } from "@vashistha/core/domains/kyc";
import { ReviewEditsSchema, SessionModeSchema, type SessionMode } from "../../contracts/casedesk";
import { ApiFailure } from "./http";

/** Payload schema version of every CaseDesk ledger entry, and the KYC case schema version. */
export const CASEDESK_SCHEMA_VERSION = 1;

/** Case sets the browser may use; `bench` is for Apprentice-Bench only and never served. */
export const SERVED_CASE_SETS = CaseSetSchema.exclude(["bench"]);

/** Review-outcome actions: the decisions the Save interlock guards. */
export const REVIEW_OUTCOME_ACTIONS: ReadonlySet<ActionId> = new Set(
  (KYC_DOMAIN.decisionFamilies.find((f) => f.id === "reviewOutcome")?.actions ?? []).filter(
    (id) => KYC_DOMAIN.actions.find((a) => a.id === id)?.terminal === true,
  ),
);

/** Features a reviewer may change through the DOM channel (the keys of the edits contract). */
export const EDITABLE_FIELDS: ReadonlySet<FeatureId> = new Set(ReviewEditsSchema.keyof().options as FeatureId[]);

export const SessionStartedPayloadSchema = z.strictObject({
  mode: SessionModeSchema,
  caseSet: CaseSetSchema,
  domainId: z.literal(KYC_DOMAIN.id),
  schemaVersion: z.literal(CASEDESK_SCHEMA_VERSION),
});

export type CaseDeskSessionInfo = { mode: SessionMode; caseSet: CaseSet; startedEntryId: string };

/** Per-process CaseDesk state; one instance lives on the runtime. */
export type CaseDeskStore = {
  /** Immutable session facts, keyed by session id. */
  sessions: Map<string, CaseDeskSessionInfo>;
  /** Highest `frameSeq` appended per session (lazily recovered from the ledger after a restart). */
  lastFrameSeq: Map<string, number>;
};

export function createCaseDeskStore(): CaseDeskStore {
  return { sessions: new Map(), lastFrameSeq: new Map() };
}

/** The interview engine's hooks (lib/server/interview), called after a CaseDesk write has succeeded. */
export type InterviewHooks = {
  /** A `case.decision` was committed: bumps the context version; in an expert session, schedules the engine step. */
  decisionCommitted: (decision: LedgerEntry, loaded: LoadedSession) => void;
  /** The reviewer opened a case or changed a field: bumps the context version. */
  screenChanged: (sessionId: string) => void;
};

/** The tutor's hooks (lib/server/tutor), called after a CaseDesk write has succeeded; they act in novice sessions only. */
export type TutorHooks = {
  /** A `case.decision` was committed: mastery outcomes, and queued interventions for the case are dropped. */
  decisionCommitted: (decision: LedgerEntry, loaded: LoadedSession) => void;
  /** DOM screen events were appended: the guardrail monitor re-checks the selected outcome after a field change. */
  screenEvents: (events: readonly LedgerEntry[], loaded: LoadedSession) => void;
};

/** What every CaseDesk handler needs; built from the runtime by `caseDeskDeps()`. */
export type CaseDeskDeps = {
  ledger: Ledger;
  store: CaseDeskStore;
  /** The confirmed rulebook in force now. */
  rulebook: () => readonly ConfirmedRule[];
  interview: InterviewHooks;
  tutor: TutorHooks;
  now: () => number;
  log: Pick<Console, "error">;
};

/** The session's mode and case set, or undefined when it is not a CaseDesk session (or does not exist). */
export function sessionInfo(ledger: Ledger, store: CaseDeskStore, sessionId: string): CaseDeskSessionInfo | undefined {
  const cached = store.sessions.get(sessionId);
  if (cached) return cached;
  const [first] = ledger.list(sessionId, { limit: 1 });
  if (first?.source !== "engine" || first.kind !== "session.started") return undefined;
  const payload = SessionStartedPayloadSchema.parse(first.payload);
  const info: CaseDeskSessionInfo = { mode: payload.mode, caseSet: payload.caseSet, startedEntryId: first.id };
  store.sessions.set(sessionId, info);
  return info;
}

export type LoadedSession = { info: CaseDeskSessionInfo; session: Session };

/** 404 unless `sessionId` names a CaseDesk session; returns its facts and live privacy state. */
export function loadSession(deps: Pick<CaseDeskDeps, "ledger" | "store">, sessionId: unknown): LoadedSession {
  const id = IdSchema.safeParse(sessionId);
  const session = id.success ? deps.ledger.getSession(id.data) : undefined;
  const info = session && sessionInfo(deps.ledger, deps.store, session.id);
  if (!session || !info) throw new ApiFailure(404, "session_not_found", "no CaseDesk session with this id");
  return { info, session };
}

/** Capture is refused while the session is off the record (plan §7.8). */
export function requireOnRecord(session: Session): void {
  if (session.offRecord) throw new ApiFailure(409, "off_record", "the session is off the record");
}
