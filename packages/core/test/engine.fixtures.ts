/** Shared fixtures for the hypothesis-engine tests (engine*.test.ts). */
import { KYC_DOMAIN } from "../src/domains/kyc";
import {
  engineConfig,
  familyModel,
  type ActionId,
  type DecisionContext,
  type FeatureId,
  type FeatureValue,
  type Observation,
  type QuestionContext,
} from "../src";

export const CONFIG = engineConfig();
export const KYC = KYC_DOMAIN;
export const REVIEW = familyModel(KYC, "reviewOutcome", CONFIG);

/** Features both scenario cases share: only ownership share, owner verification and country risk differ. */
export const SHARED = {
  entityType: "company",
  customerStatus: "existing",
  accountAgeMonths: 36,
  pep: false,
  sanctionsHit: false,
  adverseMedia: false,
  sourceOfFunds: "verified",
  expectedMonthlyVolume: 20_000,
  // The judgment features of an ordinary case: nothing unusual about the business, structure, volume, media or names.
  sectorRisk: "medium",
  ownershipTransparency: "direct",
  volumeConsistency: "consistent",
  mediaSeverity: "none",
  nameMatch: "none",
  riskRating: "unrated",
} as const;

export function observation(id: string, features: Record<string, FeatureValue>, action: string): Observation {
  return { id, caseId: id, features: features as Record<FeatureId, FeatureValue>, action: action as ActionId };
}

/** Plan §10 case A: company, largest owner 35 % unverified, medium-risk country → enhanced review. */
export const CASE_A = observation("A", { ...SHARED, uboOwnershipPct: 35, uboVerified: false, jurisdictionRisk: "medium" }, "enhancedReview");
/** Plan §10 case B: company, largest owner 20 % verified, high-risk country, existing 36 months → approve. */
export const CASE_B = observation("B", { ...SHARED, uboOwnershipPct: 20, uboVerified: true, jurisdictionRisk: "high" }, "approve");

export function contextOf(features: Record<string, FeatureValue>): DecisionContext {
  return {
    case: features as Record<FeatureId, FeatureValue>,
    workflow: { priorActions: [] },
    history: { derived: {} },
    actor: { role: "reviewer", id: "expert-1" },
    environment: { date: "2026-10-04" },
    schemaVersion: 1,
  };
}

export function questionContext(o: Pick<Observation, "caseId" | "features">, parentIds: string[] = []): QuestionContext {
  return { sessionId: "sess-1", createdAt: 1_760_000_000_000, contextVersion: 7, caseId: o.caseId, context: contextOf(o.features), parentIds };
}
