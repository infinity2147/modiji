/**
 * Predict-then-reveal (plan §7.7). The expected outcome of a case comes from the expert's confirmed
 * rulebook only: the review family's effective decision (`effectiveOutcome`, core's Kleene-aware
 * mirror of the solver's `effectiveDecision`; parity is tested). The hidden-policy oracle is never
 * consulted (bench only; a static test guards the tutor's imports). When the rules do not decide a
 * case, there is nothing to predict against, and the novice is told so instead of being asked.
 */
import "server-only";
import { ActionIdSchema, effectiveOutcome, type ActionId, type ConfirmedRule } from "@vashistha/core";
import { KYC_DOMAIN, type KycCase } from "@vashistha/core/domains/kyc";
import type { Prompt } from "../../contracts/tutor";
import { REVIEW_FAMILY } from "./rules";
import { caseLookup, type ReviewEdits } from "./session";
import type { TutorRecord } from "./state";

const FAMILY = (() => {
  const family = KYC_DOMAIN.decisionFamilies.find((f) => f.id === REVIEW_FAMILY);
  if (family === undefined) throw new Error(`the ${KYC_DOMAIN.id} domain has no ${REVIEW_FAMILY} family`);
  return family;
})();

export type Expected = { kind: "decided"; action: ActionId; ruleIds: string[] } | { kind: "none"; reason: string };

/** What the expert's confirmed rules decide for the case (with the reviewer's edits), or why nothing. */
export function expectedOutcome(rules: readonly ConfirmedRule[], kycCase: KycCase, edits: ReviewEdits): Expected {
  const outcome = effectiveOutcome(rules, FAMILY, caseLookup(kycCase, edits));
  switch (outcome.kind) {
    case "decided": {
      const action = outcome.outcome.startsWith("action:") ? ActionIdSchema.safeParse(outcome.outcome.slice("action:".length)) : undefined;
      if (action?.success === true) return { kind: "decided", action: action.data, ruleIds: outcome.ruleIds };
      return { kind: "none", reason: "The expert's rules route this case elsewhere; there is no outcome to predict." };
    }
    case "unresolved":
      return { kind: "none", reason: "The expert's confirmed rules do not decide this case yet, so there is nothing to predict against." };
    case "conflict":
      return { kind: "none", reason: "The expert's confirmed rules disagree on this case (an open debrief gap), so there is nothing to predict against." };
    case "undetermined":
      return { kind: "none", reason: "Details the expert's rules depend on are missing from this case." };
  }
}

/**
 * Whether to ask "What would the expert decide?" when the novice opens the case: only at a decision
 * node not yet mastered (some rule deciding it is below `mastered`), once per case, before deciding.
 */
export function casePrompt(record: TutorRecord, rules: readonly ConfirmedRule[], kycCase: KycCase): Prompt {
  if (record.decisions.has(kycCase.id)) return { ask: false, reason: "This case is decided." };
  if (record.predictions.has(kycCase.id)) return { ask: false, reason: "Prediction made." };
  const expected = expectedOutcome(rules, kycCase, {});
  if (expected.kind === "none") return { ask: false, reason: expected.reason };
  if (expected.ruleIds.every((id) => record.mastery.get(id) === "mastered"))
    return { ask: false, reason: "You have mastered the rules that decide this case (heuristic estimate): decide it directly." };
  return { ask: true };
}
