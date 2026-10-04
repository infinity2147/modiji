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

/**
 * Northstar's published sector risk list (fictional). Public reference data shown on screen, like the
 * country list. Cash-heavy and value-transfer businesses are the high tier.
 */
export const NORTHSTAR_SECTOR_RISK = {
  "Salaried or private individual": "low",
  "Private wealth (trust)": "low",
  "Professional services": "low",
  "Software and IT services": "low",
  "Healthcare supplies": "low",
  Hospitality: "low",
  "Marine logistics": "medium",
  "Agricultural trade": "medium",
  "Textile imports": "medium",
  "Commodities trading": "medium",
  Construction: "medium",
  "Real estate brokerage": "medium",
  "Energy and utilities": "medium",
  "Cash-intensive retail": "high",
  "Currency exchange and remittance": "high",
  "Precious metals and jewellery": "high",
  "Online gaming": "high",
} as const satisfies Record<string, "low" | "medium" | "high">;
export type NorthstarSector = keyof typeof NORTHSTAR_SECTOR_RISK;
export const NORTHSTAR_SECTORS = Object.keys(NORTHSTAR_SECTOR_RISK) as [NorthstarSector, ...NorthstarSector[]];

/**
 * Expected activity against what the customer declared. The annualised expected volume is compared with the declared
 * annual turnover (income, for an individual): up to 1.25x is consistent, up to 2.5x elevated, beyond that inconsistent.
 */
export const VOLUME_ELEVATED_RATIO = 1.25;
export const VOLUME_INCONSISTENT_RATIO = 2.5;

export const CASE_SETS = ["training", "heldout", "practice", "bench"] as const;
export const CaseSetSchema = z.enum(CASE_SETS);
export type CaseSet = z.infer<typeof CaseSetSchema>;

export const RiskRatingSchema = z.enum(["unrated", "low", "medium", "high"]);

/** Who stands behind a shareholding: a person, a holding company above the customer, or a nominee for an undisclosed party. */
export const OWNER_KINDS = ["person", "holding_company", "nominee"] as const;

const OwnerSchema = z.strictObject({
  name: z.string().min(1),
  role: z.string().min(1),
  sharePct: z.number().min(0).max(100),
  idVerified: z.boolean(),
  pep: z.boolean(),
  /** Absent in cases from before ownership structure was modelled: a person. */
  kind: z.enum(OWNER_KINDS).default("person"),
  /** For a holding company or nominee: who is known to stand behind it (free text shown to the reviewer). */
  controller: z.string().optional(),
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
    /** What the customer does and what it declared; absent in older cases (then a low-risk, consistent profile). */
    business: z
      .strictObject({
        sector: z.enum(NORTHSTAR_SECTORS),
        description: z.string(),
        /** Declared annual turnover (annual income for an individual); 0 when none was declared. */
        declaredAnnualEur: z.int().min(0).max(1_000_000_000),
      })
      .optional(),
    screening: z.strictObject({
      /** A confirmed list match. A merely similar name is `nameMatch`. */
      sanctions: z.strictObject({ status: z.enum(["clear", "match"]), detail: z.string() }),
      adverseMedia: z.strictObject({
        status: z.enum(["none", "found"]),
        detail: z.string(),
        /** How serious the reported conduct is; only meaningful when something was found. */
        severity: z.enum(["minor", "serious"]).default("minor"),
      }),
      /** An unconfirmed, name-only similarity to a sanctions-list entry; how strong decides what a reviewer may do with it. */
      nameMatch: z
        .strictObject({ strength: z.enum(["none", "weak", "strong"]), detail: z.string() })
        .default({ strength: "none", detail: "No similar names on the Northstar Synthetic Sanctions List." }),
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
    if (c.customer.entityType === "individual" && c.owners.some((o) => o.kind !== "person"))
      ctx.addIssue({ code: "custom", message: "an individual has no holding company or nominee above them", path: ["owners"] });
    if (c.customer.entityType !== "company" && c.business !== undefined && NORTHSTAR_SECTOR_RISK[c.business.sector] !== "low")
      ctx.addIssue({ code: "custom", message: "only a company can be in a medium or high-risk sector", path: ["business"] });
    if (c.screening.sanctions.status === "match" && c.screening.nameMatch.strength !== "none")
      ctx.addIssue({ code: "custom", message: "a confirmed sanctions match supersedes a name match", path: ["screening"] });
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

/** Annualised expected volume over declared annual turnover; undefined when nothing was declared (or none expected). */
export function volumeRatio(c: KycCase): number | undefined {
  const declared = c.business?.declaredAnnualEur ?? 0;
  const annual = c.funds.expectedMonthlyVolumeEur * 12;
  return declared > 0 && annual > 0 ? annual / declared : undefined;
}

export function volumeConsistency(c: KycCase): "consistent" | "elevated" | "inconsistent" {
  const ratio = volumeRatio(c);
  if (ratio === undefined || ratio <= VOLUME_ELEVATED_RATIO) return "consistent";
  return ratio <= VOLUME_INCONSISTENT_RATIO ? "elevated" : "inconsistent";
}

/** `nominee` if any owner is a nominee, else `layered` if a holding company sits above the customer, else `direct`. */
export function ownershipTransparency(c: KycCase): "direct" | "layered" | "nominee" {
  if (c.owners.some((o) => o.kind === "nominee")) return "nominee";
  return c.owners.some((o) => o.kind === "holding_company") ? "layered" : "direct";
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
    sectorRisk: c.business === undefined ? "low" : NORTHSTAR_SECTOR_RISK[c.business.sector],
    ownershipTransparency: ownershipTransparency(c),
    volumeConsistency: volumeConsistency(c),
    mediaSeverity: c.screening.adverseMedia.status === "found" ? c.screening.adverseMedia.severity : "none",
    nameMatch: c.screening.nameMatch.strength,
    riskRating: edits.riskRating ?? c.review.riskRating,
  };
  return features as Record<FeatureId, Value>;
}
