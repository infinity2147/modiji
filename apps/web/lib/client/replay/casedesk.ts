/**
 * CaseDesk as it stood at a point of a recorded session (pure): the decisions are `summariseLedger` —
 * the very fold the live CaseDesk resumes from — and the rest is read off the recorded DOM-channel and
 * tutor entries: which case was open, the risk rating edits, the outcome selected, and which generated
 * cases (practice, judge-entered) had been added to the queue by then. Nothing is inferred beyond them.
 */
import { parseLedgerPayload, type ActionId, type LedgerEntry } from "@vashistha/core";
import type { KycCase } from "@vashistha/core/domains/kyc";
import { RiskRatingSchema } from "@vashistha/core/domains/kyc";
import { summariseLedger, type RiskRating, type SessionState } from "../session-state";

export type ReplayDraft = { riskRating: RiskRating; outcome: ActionId | undefined };

export type ReplayCaseDesk = {
  session: SessionState;
  cases: KycCase[];
  selectedId: string | undefined;
  drafts: ReadonlyMap<string, ReplayDraft>;
  /** The case whose decision was the last thing that happened on the desk (the live "committed" highlight). */
  lastCommitted: string | undefined;
};

function safely<T>(read: () => T): T | undefined {
  try {
    return read();
  } catch {
    return undefined;
  }
}

/** Case ids that sessions generated (practice, judge-entered): listed only once their `case.generated` entry has happened. */
export function generatedCaseIds(entries: readonly LedgerEntry[]): Set<string> {
  const ids = new Set<string>();
  for (const e of entries) {
    if (e.kind !== "case.generated") continue;
    const p = safely(() => parseLedgerPayload(e, "case.generated"));
    if (p) ids.add(p.case.id);
  }
  return ids;
}

/** CaseDesk of one session after `entries` (that session's entries, oldest first); null before it started. */
export function replayCaseDesk(entries: readonly LedgerEntry[], recordedCases: readonly KycCase[], generatedInRun: ReadonlySet<string>): ReplayCaseDesk | null {
  const session = safely(() => summariseLedger(entries));
  if (session === undefined) return null;
  const generatedNow = generatedCaseIds(entries);
  const cases = recordedCases.filter((c) => !generatedInRun.has(c.id) || generatedNow.has(c.id));
  const known = new Map(cases.map((c) => [c.id, c]));

  let selectedId: string | undefined;
  let lastCommitted: string | undefined;
  const rating = new Map<string, RiskRating>();
  const outcome = new Map<string, ActionId>();
  for (const e of entries) {
    switch (e.kind) {
      case "screen.event": {
        if (e.source !== "dom") break;
        const p = safely(() => parseLedgerPayload(e, "screen.event"));
        if (p?.caseId === undefined) break;
        if (p.kind === "open_case") {
          if (p.caseId !== selectedId) lastCommitted = undefined;
          selectedId = p.caseId;
        }
        const to = RiskRatingSchema.safeParse(p.to);
        if (p.kind === "field_change" && p.field === "riskRating" && to.success) rating.set(p.caseId, to.data);
        break;
      }
      case "tutor.intent": {
        const p = safely(() => parseLedgerPayload(e, "tutor.intent"));
        if (!p) break;
        selectedId = p.caseId;
        outcome.set(p.caseId, p.proposedAction);
        break;
      }
      case "interlock.check": {
        const p = safely(() => parseLedgerPayload(e, "interlock.check"));
        if (!p) break;
        selectedId = p.caseId;
        outcome.set(p.caseId, p.action);
        break;
      }
      case "tutor.prediction": {
        const p = safely(() => parseLedgerPayload(e, "tutor.prediction"));
        if (p) selectedId = p.caseId;
        break;
      }
      case "case.decision": {
        const p = safely(() => parseLedgerPayload(e, "case.decision"));
        if (!p) break;
        selectedId = p.caseId;
        lastCommitted = p.caseId;
        outcome.set(p.caseId, p.action);
        break;
      }
    }
  }

  const drafts = new Map<string, ReplayDraft>();
  for (const c of cases) {
    const decided = session.decisions.get(c.id);
    drafts.set(c.id, { riskRating: rating.get(c.id) ?? decided?.riskRating ?? c.review.riskRating, outcome: outcome.get(c.id) });
  }
  return { session, cases, selectedId: selectedId !== undefined && known.has(selectedId) ? selectedId : undefined, drafts, lastCommitted };
}
