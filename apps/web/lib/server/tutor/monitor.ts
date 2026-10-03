/**
 * The guardrail monitor (plan §7.7): on every novice context update (an outcome selected, a field
 * changed), the same deterministic `checkAction` as the Save interlock runs over the expert's
 * confirmed rulebook. A stop-rule violated (`forbid`), or a stop-rule that cannot be ruled out
 * (`insufficient_information`), is an intervention: `tutor.intervention` (parents: the triggering
 * entry and the rules' own entries) and an ephemeral `intervention` question, which the browser gate
 * in tutor mode authorizes as soon as the session is on the record and the agent is idle (safety
 * overrides politeness, plan §7.4). The spoken text is precomputed from the rule and the expert's
 * exact quote. One intervention per (case, action, rule). A queued intervention whose selection was
 * changed before it could be spoken is dropped, so the tutor never warns about a choice already undone.
 */
import "server-only";
import { randomUUID } from "node:crypto";
import { checkAction, type ActionId, type ConfirmedRule, type FeatureLookup, type GuardrailResult, type LedgerEntry, type Question } from "@vashistha/core";
import { KYC_DOMAIN, type KycCase } from "@vashistha/core/domains/kyc";
import type { InterventionView } from "../../contracts/tutor";
import type { LoadedSession } from "../casedesk/session";
import { entry, type EntryContext } from "../interview/ledger";
import type { TutorDeps } from "./deps";
import { interventionOutcomes, recordOutcomes } from "./mastery";
import { REVIEW_FAMILY, interventionText, isStopRule } from "./rules";
import { caseLookup, entryContext, ruleEntryIds, type ReviewEdits } from "./session";
import { isBoundaryCase, queuedInterventions, speechOf, tutorRecord, type Recorded, type TutorRecord } from "./state";

/** Priority of an intervention in the question queue: above every live question (EIG is at most a few bits). */
export const INTERVENTION_PRIORITY = 100;

export type MonitorResult = {
  result: GuardrailResult;
  /** The warning for this selection (recorded now, or earlier), or null. */
  intervention: InterventionView | null;
  fresh: boolean;
};

export function interventionView(record: TutorRecord, i: Recorded<"tutor.intervention">): InterventionView {
  const { payload } = i;
  return {
    entryId: i.entry.id,
    caseId: payload.caseId,
    trigger: payload.trigger,
    proposedAction: payload.proposedAction,
    ruleIds: payload.ruleIds,
    questionId: payload.questionId,
    text: record.interventionQuestions.get(payload.questionId)?.text ?? "",
    speech: speechOf(record, payload.questionId),
  };
}

export type Selection = {
  result: GuardrailResult;
  /** The stop-rules behind a `forbid` or `insufficient_information` result (approval rules never trigger an intervention). */
  stopRules: ConfirmedRule[];
  trigger: InterventionView["trigger"];
};

/** The Save interlock's own evaluation of a selection, and what the monitor makes of it. Pure. */
export function evaluateSelection(rules: readonly ConfirmedRule[], features: FeatureLookup, action: ActionId): Selection {
  const result = checkAction({ rules, features, action, domain: KYC_DOMAIN });
  const matched = new Set(result.matchedRules);
  const stopping = result.decision === "forbid" || result.decision === "insufficient_information";
  return {
    result,
    stopRules: stopping ? rules.filter((r) => matched.has(r.id) && isStopRule(r)) : [],
    trigger: result.decision === "forbid" ? "guardrail_violation" : "insufficient_information",
  };
}

/**
 * Drops the case's queued (unspoken) interventions that no longer apply: all of them once the case
 * is committed (`keepAction` undefined), else those about another outcome than `keepAction`.
 */
export function dropStaleInterventions(
  deps: Pick<TutorDeps, "ledger">,
  ctx: EntryContext,
  input: { record: TutorRecord; caseId: string; keepAction: ActionId | undefined; trigger: string },
): void {
  const { record } = input;
  const stale = queuedInterventions(record).filter(
    (i) => i.payload.caseId === input.caseId && (input.keepAction === undefined || i.payload.proposedAction !== input.keepAction),
  );
  deps.ledger.appendMany(
    stale.map((i) => {
      const queued = record.interventionQuestions.get(i.payload.questionId)?.entryId;
      return entry(ctx, "question.dropped", "engine", [queued ?? i.entry.id, input.trigger], {
        questionId: i.payload.questionId,
        reason: input.keepAction === undefined ? "superseded" : "context_changed",
      });
    }),
  );
}

/** Runs the monitor for one selected outcome; `trigger` is the entry that carried the selection or the field change. */
export function monitorSelection(
  deps: TutorDeps,
  loaded: LoadedSession,
  input: { kycCase: KycCase; action: ActionId; edits: ReviewEdits; trigger: LedgerEntry },
): MonitorResult {
  const { kycCase, action, trigger } = input;
  const book = deps.rulebook();
  const { result, stopRules: stop, trigger: trig } = evaluateSelection(book.rules, caseLookup(kycCase, input.edits), action);
  const ctx = entryContext(deps, loaded, trigger.traceId);
  dropStaleInterventions(deps, ctx, { record: tutorRecord(deps.ledger, loaded.session.id), caseId: kycCase.id, keepAction: action, trigger: trigger.id });

  const record = tutorRecord(deps.ledger, loaded.session.id);
  const given = record.interventions.filter((i) => i.payload.caseId === kycCase.id && i.payload.proposedAction === action);
  const covered = new Set(given.flatMap((i) => i.payload.ruleIds));
  const fresh = stop.filter((r) => !covered.has(r.id));
  const [lead] = fresh;
  if (lead === undefined) {
    const earlier = given.findLast((i) => i.payload.ruleIds.some((id) => stop.some((r) => r.id === id)));
    return { result, intervention: earlier === undefined ? null : interventionView(record, earlier), fresh: false };
  }

  const ruleEntries = ruleEntryIds(book);
  const questionId = randomUUID();
  const intervention = deps.ledger.append(
    entry(ctx, "tutor.intervention", "engine", [trigger.id, ...fresh.flatMap((r) => ruleEntries.get(r.id) ?? [])], {
      caseId: kycCase.id,
      trigger: trig,
      proposedAction: action,
      ruleIds: fresh.map((r) => r.id),
      questionId,
    }),
  );
  const question: Question = {
    id: questionId,
    sessionId: loaded.session.id,
    kind: "intervention",
    text: interventionText({ rule: lead, trigger: trig, proposedAction: action, missingFeatures: result.missingFeatures }),
    decisionFamily: REVIEW_FAMILY,
    target: { caseId: kycCase.id, candidateIds: [], ruleId: lead.id },
    value: INTERVENTION_PRIORITY,
    reason: trig === "guardrail_violation" ? "stop-rule violation sensed before Save" : "stop-rule needs missing information",
    ephemeral: true,
    createdAt: deps.now(),
    contextVersion: deps.authorizations.getContextVersion(loaded.session.id),
    parentIds: [intervention.id],
  };
  deps.ledger.append(entry(ctx, "question.queued", "engine", [intervention.id], question));
  if (trig === "guardrail_violation")
    recordOutcomes(deps, ctx, {
      levels: new Map(record.mastery),
      outcomes: interventionOutcomes(fresh.map((r) => r.id), isBoundaryCase(record, kycCase.id)),
      trigger: intervention.id,
      ruleEntries,
    });
  const after = tutorRecord(deps.ledger, loaded.session.id);
  const recorded = after.interventions.find((i) => i.entry.id === intervention.id);
  return { result, intervention: recorded === undefined ? null : interventionView(after, recorded), fresh: true };
}
