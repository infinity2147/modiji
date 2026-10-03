/**
 * The bench's view of the public KYC domain (browser-safe, oracle-free). The bench evaluates the
 * `reviewOutcome` family: the onboarding decision whose wrong "approve" is the unsafe error.
 */
import { ActionIdSchema, type ActionId, type Assignment, type DecisionFamily } from "@vashistha/core";
import { KYC_DOMAIN, caseFeatures, type KycCase } from "@vashistha/core/domains/kyc";

export const DOMAIN = KYC_DOMAIN;
export const FAMILY_ID = "reviewOutcome";
export const APPROVE: ActionId = ActionIdSchema.parse("approve");

function findFamily(): DecisionFamily {
  const family = DOMAIN.decisionFamilies.find((f) => f.id === FAMILY_ID);
  if (family === undefined) throw new Error(`domain ${DOMAIN.id} has no family ${FAMILY_ID}`);
  return family;
}
export const FAMILY = findFamily();

/** A complete feature assignment of a case (every KYC case feature is known on screen). */
export function featuresOf(c: KycCase): Assignment {
  return caseFeatures(c) as Assignment;
}
