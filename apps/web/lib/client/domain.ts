/**
 * Display vocabulary for CaseDesk, read from the browser-safe KYC domain config so labels on screen
 * and identifiers in the ledger can never disagree.
 */
import type { ActionId, GuardrailResult } from "@vashistha/core";
import { KYC_DOMAIN, RiskRatingSchema } from "@vashistha/core/domains/kyc";
import type { RiskRating } from "./session-state";

const ACTIONS = new Map(KYC_DOMAIN.actions.map((a) => [a.id as string, a]));
const FEATURES = new Map(KYC_DOMAIN.features.map((f) => [f.id as string, f]));

/** The terminal actions of the `reviewOutcome` decision family, in domain order. */
export const REVIEW_OUTCOMES: readonly { id: ActionId; label: string }[] = (
  KYC_DOMAIN.decisionFamilies.find((f) => f.id === "reviewOutcome")?.actions ?? []
).flatMap((id) => {
  const action = ACTIONS.get(id);
  return action?.terminal ? [{ id: action.id, label: action.label }] : [];
});

export function actionLabel(id: string): string {
  return ACTIONS.get(id)?.label ?? id;
}

export function featureLabel(id: string): string {
  return FEATURES.get(id)?.label ?? id;
}

export const RISK_RATINGS: readonly RiskRating[] = RiskRatingSchema.options;

const RISK_RATING_LABELS: Record<RiskRating, string> = { unrated: "Unrated", low: "Low", medium: "Medium", high: "High" };

export function riskRatingLabel(rating: RiskRating): string {
  return RISK_RATING_LABELS[rating];
}

/** What the Save interlock asks of the reviewer for a given result. */
export type InterlockPrompt = "commit" | "blocked" | "needs_override";

export function interlockPrompt(result: GuardrailResult): InterlockPrompt {
  switch (result.decision) {
    case "allow":
      return "commit";
    case "forbid":
      return "blocked";
    case "needs_approval":
    case "insufficient_information":
      return "needs_override";
  }
}
