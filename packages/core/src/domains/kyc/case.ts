/**
 * A CaseDesk case as the reviewer sees it. Decision features are never stored alongside the display
 * data: `caseFeatures` derives them, so what the screen shows and what rules evaluate cannot drift.
 * All names, companies, countries and numbers are synthetic.
 */
import { z } from "zod";
import type { FeatureId, Value } from "../../schemas/primitives";

/** Northstar's published country risk list (fictional jurisdictions). Public reference data shown on screen. */
export const NORTHSTAR_COUNTRY_RISK = {
  Aldermere: "low",
  Brightwater: "low",
  Calderon: "low",
  "Dunmore Isles": "medium",
  Estoria: "medium",
  Faraway: "medium",
  Galvania: "high",
  "Harrow Bay": "high",
  Isterra: "high",
} as const satisfies Record<string, "low" | "medium" | "high">;
export type NorthstarCountry = keyof typeof NORTHSTAR_COUNTRY_RISK;
export const NORTHSTAR_COUNTRIES = Object.keys(NORTHSTAR_COUNTRY_RISK) as [NorthstarCountry, ...NorthstarCountry[]];

export const CASE_SETS = ["training", "heldout", "practice", "bench"] as const;
export const CaseSetSchema = z.enum(CASE_SETS);
export type CaseSet = z.infer<typeof CaseSetSchema>;

export const RiskRatingSchema = z.enum(["unrated", "low", "medium", "high"]);

const OwnerSchema = z.strictObject({
  name: z.string().min(1),
  role: z.string().min(1),
  sharePct: z.number().min(0).max(100),
  idVerified: z.boolean(),
  pep: z.boolean(),
});

export const KycCaseSchema = z
  .strictObject({
    id: z.string().regex(/^NS-\d{4}-\d{4}$/),
    set: CaseSetSchema,
    submittedAt: z.iso.date(),
    customer: z.strictObject({
      name: z.string().min(1),
      entityType: z.enum(["individual", "company", "trust"]),
      registrationNo: z.string().min(1),
      country: z.enum(NORTHSTAR_COUNTRIES),
      address: z.string().min(1),
    }),
    relationship: z.strictObject({
      status: z.enum(["new", "existing"]),
      accountAgeMonths: z.int().min(0).max(600),
      relationshipManager: z.string().min(1),
    }),
    /** Beneficial owners for companies/trusts; the customer themself (100 %) for individuals. */
    owners: z.array(OwnerSchema).min(1),
    screening: z.strictObject({
      sanctions: z.strictObject({ status: z.enum(["clear", "match"]), detail: z.string() }),
      adverseMedia: z.strictObject({ status: z.enum(["none", "found"]), detail: z.string() }),
    }),
    funds: z.strictObject({
      sourceOfFunds: z.enum(["verified", "unverified", "not_provided"]),
      description: z.string(),
      expectedMonthlyVolumeEur: z.int().min(0).max(10_000_000),
    }),
    documents: z.array(
      z.strictObject({ name: z.string().min(1), status: z.enum(["received", "missing", "expired"]) }),
    ),
    /** Reviewer-editable state at the moment the case was opened. */
    review: z.strictObject({ riskRating: RiskRatingSchema }),
  })
  .superRefine((c, ctx) => {
    const total = c.owners.reduce((s, o) => s + o.sharePct, 0);
    if (total > 100 + 1e-9) ctx.addIssue({ code: "custom", message: `owner shares sum to ${total}`, path: ["owners"] });
    if (c.customer.entityType === "individual" && (c.owners.length !== 1 || c.owners[0]?.sharePct !== 100))
      ctx.addIssue({ code: "custom", message: "an individual is their own single 100% owner", path: ["owners"] });
    if ((c.relationship.status === "new") !== (c.relationship.accountAgeMonths === 0))
      ctx.addIssue({ code: "custom", message: "accountAgeMonths is 0 exactly for new customers", path: ["relationship"] });
  });
export type KycCase = z.infer<typeof KycCaseSchema>;

/** Reviewer edits applied on top of the opened case (only the risk rating is editable in CaseDesk). */
export type KycReviewEdits = Partial<KycCase["review"]>;

/** The largest beneficial owner (ties broken by list order). */
export function largestOwner(c: KycCase): KycCase["owners"][number] {
  return c.owners.reduce((best, o) => (o.sharePct > best.sharePct ? o : best));
}

/** Decision features for the KYC domain, derived from what the screen shows. */
export function caseFeatures(c: KycCase, edits: KycReviewEdits = {}): Record<FeatureId, Value> {
  const ubo = largestOwner(c);
  const features: Record<string, Value> = {
    entityType: c.customer.entityType,
    customerStatus: c.relationship.status,
    accountAgeMonths: c.relationship.accountAgeMonths,
    jurisdictionRisk: NORTHSTAR_COUNTRY_RISK[c.customer.country],
    uboOwnershipPct: ubo.sharePct,
    uboVerified: ubo.idVerified,
    pep: c.owners.some((o) => o.pep),
    sanctionsHit: c.screening.sanctions.status === "match",
    adverseMedia: c.screening.adverseMedia.status === "found",
    sourceOfFunds: c.funds.sourceOfFunds,
    expectedMonthlyVolume: c.funds.expectedMonthlyVolumeEur,
    riskRating: edits.riskRating ?? c.review.riskRating,
  };
  return features as Record<FeatureId, Value>;
}
