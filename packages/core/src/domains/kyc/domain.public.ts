/**
 * Synthetic KYC domain (D1): "Northstar Bank Synthetic Review Policy". Fictional bank, fictional
 * jurisdictions, fictional thresholds — never presented as real law. Browser-safe: this file holds
 * only what a reviewer can see on screen. The hidden policy lives in `domain.oracle.server.ts`.
 */
import { loadDomainConfig } from "../../domain/parse";
import type { DomainConfigInput } from "../../schemas/domain";

const raw = {
  id: "kycNorthstar",
  title: "Northstar Bank — Synthetic KYC Review",
  features: [
    {
      id: "entityType",
      label: "Entity type",
      source: "case",
      type: "enum",
      values: ["individual", "company", "trust"],
    },
    { id: "customerStatus", label: "Customer status", source: "case", type: "enum", values: ["new", "existing"] },
    {
      id: "accountAgeMonths",
      label: "Relationship age (months)",
      source: "case",
      type: "number",
      min: 0,
      max: 600,
      integer: true,
      unit: "months",
    },
    {
      id: "jurisdictionRisk",
      label: "Country risk (Northstar list)",
      source: "case",
      type: "enum",
      values: ["low", "medium", "high"],
    },
    {
      id: "uboOwnershipPct",
      label: "Largest beneficial owner share",
      description: "Share held by the largest ultimate beneficial owner; 100 for individuals.",
      source: "case",
      type: "number",
      min: 0,
      max: 100,
      integer: false,
      unit: "%",
    },
    { id: "uboVerified", label: "Largest owner identity verified", source: "case", type: "boolean" },
    { id: "pep", label: "Politically exposed person", source: "case", type: "boolean" },
    { id: "sanctionsHit", label: "Sanctions screening match", source: "case", type: "boolean" },
    { id: "adverseMedia", label: "Adverse media", source: "case", type: "boolean" },
    {
      id: "sourceOfFunds",
      label: "Source of funds",
      source: "case",
      type: "enum",
      values: ["verified", "unverified", "not_provided"],
    },
    {
      id: "expectedMonthlyVolume",
      label: "Expected monthly volume",
      source: "case",
      type: "number",
      min: 0,
      max: 10_000_000,
      integer: true,
      unit: "EUR",
    },
    {
      id: "riskRating",
      label: "Analyst risk rating",
      description: "Set by the reviewer during the review.",
      source: "case",
      type: "enum",
      values: ["unrated", "low", "medium", "high"],
    },
  ],
  actions: [
    { id: "approve", label: "Approve onboarding", terminal: true },
    { id: "enhancedReview", label: "Send to enhanced review", terminal: true },
    { id: "requestDocuments", label: "Request documents", terminal: true },
    { id: "escalateCompliance", label: "Escalate to compliance officer", terminal: true },
    { id: "reject", label: "Reject", terminal: true },
    { id: "rateLow", label: "Rate risk: low", terminal: false },
    { id: "rateMedium", label: "Rate risk: medium", terminal: false },
    { id: "rateHigh", label: "Rate risk: high", terminal: false },
  ],
  decisionFamilies: [
    {
      id: "reviewOutcome",
      label: "Review outcome",
      actions: ["approve", "enhancedReview", "requestDocuments", "escalateCompliance", "reject"],
    },
    { id: "riskRating", label: "Risk rating", actions: ["rateLow", "rateMedium", "rateHigh"] },
  ],
  domainConstraints: [
    // An individual is their own beneficial owner.
    { or: [{ "!=": [{ var: "entityType" }, "individual"] }, { "==": [{ var: "uboOwnershipPct" }, 100] }] },
    // New customers have no relationship history; existing ones have at least a month.
    { or: [{ "!=": [{ var: "customerStatus" }, "new"] }, { "==": [{ var: "accountAgeMonths" }, 0] }] },
    { or: [{ "!=": [{ var: "customerStatus" }, "existing"] }, { ">=": [{ var: "accountAgeMonths" }, 1] }] },
  ],
  criticalFields: [
    "entityType",
    "customerStatus",
    "accountAgeMonths",
    "jurisdictionRisk",
    "uboOwnershipPct",
    "uboVerified",
    "pep",
    "sanctionsHit",
    "adverseMedia",
    "sourceOfFunds",
    "expectedMonthlyVolume",
    "riskRating",
  ],
} satisfies DomainConfigInput;

export const KYC_DOMAIN = loadDomainConfig(raw);
