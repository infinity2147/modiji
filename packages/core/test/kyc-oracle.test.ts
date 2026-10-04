import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { OracleMarkerSchema, typecheckPredicate, unknown, type FeatureLookup } from "../src";
import { KYC_DOMAIN, caseFeatures, generateBenchCases, generateKycCase, kycCases, mulberry32, type KycCase } from "../src/domains/kyc";
import { KYC_HIDDEN_POLICY, ORACLE_MARKER } from "../src/domains/kyc/domain.oracle.server";
import { lookupFrom } from "./helpers";

const KYC_DIR = path.resolve(import.meta.dirname, "../src/domains/kyc");
const lookup = (c: KycCase): FeatureLookup => lookupFrom(caseFeatures(c));
const evaluateCase = (c: KycCase) => KYC_HIDDEN_POLICY.evaluate(lookup(c));

describe("NSRP-1 oracle module", () => {
  it("follows the oracle marker convention and embeds the marker in the policy", () => {
    expect(ORACLE_MARKER).toMatch(/^oracle:kycNorthstar:[0-9a-f]{16,}$/);
    expect(OracleMarkerSchema.safeParse(ORACLE_MARKER).success).toBe(true);
    expect(KYC_HIDDEN_POLICY.marker).toBe(ORACLE_MARKER);
    expect(KYC_HIDDEN_POLICY.domainId).toBe(KYC_DOMAIN.id);
    expect(JSON.stringify(KYC_HIDDEN_POLICY)).toContain(ORACLE_MARKER);
  });

  it("starts with `import \"server-only\";`", async () => {
    const source = await readFile(path.join(KYC_DIR, "domain.oracle.server.ts"), "utf8");
    expect(source.trimStart().startsWith('import "server-only";')).toBe(true);
  });

  it("has rules that all type-check against KYC_DOMAIN and have unique ids", () => {
    for (const r of KYC_HIDDEN_POLICY.rules) expect(typecheckPredicate(r.predicate, KYC_DOMAIN.features), r.id).toEqual([]);
    const ids = KYC_HIDDEN_POLICY.rules.map((r) => r.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("is never imported by the browser-safe KYC modules", async () => {
    const files = (await readdir(KYC_DIR)).filter((f) => f.endsWith(".ts") && f !== "domain.oracle.server.ts");
    expect(files).toEqual(expect.arrayContaining(["case.ts", "cases.ts", "domain.public.ts", "generator.ts", "index.ts"]));
    for (const file of files) {
      const source = await readFile(path.join(KYC_DIR, file), "utf8");
      const specifiers = [...source.matchAll(/(?:import|export)\b[^;]*?["']([^"']+)["']|import\s*\(\s*["']([^"']+)["']/g)].map((m) => m[1] ?? m[2]);
      expect(specifiers.length, file).toBeGreaterThan(0);
      for (const s of specifiers) expect(s, `${file} imports ${s}`).not.toMatch(/oracle/);
    }
  });

  it("is defined on complete cases only", () => {
    const [first] = kycCases("training");
    if (first === undefined) throw new Error("no training case");
    const features = caseFeatures(first);
    const partial: FeatureLookup = (id) => (id === "pep" ? unknown("not_visible") : (features[id] ?? unknown("not_extracted")));
    expect(() => KYC_HIDDEN_POLICY.evaluate(partial)).toThrow(/complete cases only/);
  });

  it("exposes a copy of its rules: mutating them does not change evaluation", () => {
    const sanctions = kycCases("heldout").find((c) => c.id === "NS-2026-0202");
    if (sanctions === undefined) throw new Error("missing case");
    const before = evaluateCase(sanctions);
    const removed = KYC_HIDDEN_POLICY.rules.splice(0);
    try {
      expect(evaluateCase(sanctions)).toEqual(before);
    } finally {
      KYC_HIDDEN_POLICY.rules.push(...removed);
    }
  });
});

describe("NSRP-1 outcomes on the demo cases", () => {
  const EXPECTED: Record<string, { outcome: string; fired: string[]; rating: string; ratingFired: string[]; forbidden: string[] }> = {
    "NS-2026-0101": { outcome: "enhancedReview", fired: ["nsrp.ubo.threshold"], rating: "rateMedium", ratingFired: ["nsrp.rating.medium"], forbidden: [] },
    "NS-2026-0102": { outcome: "approve", fired: ["nsrp.highrisk.longstanding"], rating: "rateHigh", ratingFired: ["nsrp.rating.high"], forbidden: [] },
    "NS-2026-0103": {
      outcome: "escalateCompliance",
      fired: ["nsrp.pep.approval", "nsrp.pep.escalate"],
      rating: "rateHigh",
      ratingFired: ["nsrp.rating.high"],
      forbidden: [],
    },
    "NS-2026-0201": {
      outcome: "enhancedReview",
      fired: ["nsrp.highrisk.edd"],
      rating: "rateHigh",
      ratingFired: ["nsrp.rating.high", "nsrp.rating.medium"],
      forbidden: [],
    },
    "NS-2026-0202": {
      outcome: "reject",
      fired: ["nsrp.sanctions.no_approve", "nsrp.sanctions.reject"],
      rating: "rateHigh",
      ratingFired: ["nsrp.rating.high", "nsrp.rating.medium"],
      forbidden: ["approve"],
    },
    "NS-2026-0104": { outcome: "enhancedReview", fired: ["nsrp.sector.cash"], rating: "rateMedium", ratingFired: ["nsrp.rating.medium"], forbidden: [] },
    "NS-2026-0105": { outcome: "approve", fired: ["nsrp.sector.cash.established"], rating: "rateMedium", ratingFired: ["nsrp.rating.medium"], forbidden: [] },
    "NS-2026-0106": {
      outcome: "requestDocuments",
      fired: ["nsrp.structure.nominee", "nsrp.ubo.threshold"],
      rating: "rateHigh",
      ratingFired: ["nsrp.rating.high", "nsrp.rating.medium"],
      forbidden: [],
    },
    "NS-2026-0107": {
      outcome: "escalateCompliance",
      fired: ["nsrp.name.strong.escalate", "nsrp.name.strong.no_approve"],
      rating: "rateHigh",
      ratingFired: ["nsrp.rating.high"],
      forbidden: ["approve"],
    },
    "NS-2026-0108": {
      outcome: "escalateCompliance",
      fired: ["nsrp.media.serious"],
      rating: "rateHigh",
      ratingFired: ["nsrp.rating.high", "nsrp.rating.medium"],
      forbidden: [],
    },
    "NS-2026-0203": {
      outcome: "requestDocuments",
      fired: ["nsrp.volume.inconsistent", "nsrp.sector.cash"],
      rating: "rateMedium",
      ratingFired: ["nsrp.rating.medium"],
      forbidden: [],
    },
    "NS-2026-0204": { outcome: "enhancedReview", fired: ["nsrp.structure.layered"], rating: "rateMedium", ratingFired: ["nsrp.rating.medium"], forbidden: [] },
    "NS-2026-0205": { outcome: "approve", fired: [], rating: "rateMedium", ratingFired: ["nsrp.rating.medium"], forbidden: [] },
    "NS-2026-0206": {
      outcome: "escalateCompliance",
      fired: ["nsrp.media.serious"],
      rating: "rateHigh",
      ratingFired: ["nsrp.rating.high", "nsrp.rating.medium"],
      forbidden: [],
    },
  };

  it.each([...kycCases("training"), ...kycCases("heldout")])("$id", (c) => {
    const expected = EXPECTED[c.id];
    if (expected === undefined) throw new Error(`no expectation for ${c.id}`);
    expect(evaluateCase(c)).toEqual({
      decisions: {
        reviewOutcome: { action: expected.outcome, firedRuleIds: expected.fired },
        riskRating: { action: expected.rating, firedRuleIds: expected.ratingFired },
      },
      forbidden: expected.forbidden,
    });
  });

  it("training cases 1 and 2 differ in both ownership and jurisdiction (the capture-phase contradiction)", () => {
    const [one, two] = kycCases("training").map((c) => caseFeatures(c));
    expect(one).toMatchObject({ jurisdictionRisk: "medium", uboOwnershipPct: 35, uboVerified: false });
    expect(two).toMatchObject({ jurisdictionRisk: "high", uboOwnershipPct: 20, uboVerified: false });
  });

  it("the overridden rule would otherwise fire: removing the exception's conditions sends case 2 to enhanced review", () => {
    const [, two] = kycCases("training");
    if (two === undefined) throw new Error("missing case");
    const features = { ...caseFeatures(two), accountAgeMonths: 12 };
    const result = KYC_HIDDEN_POLICY.evaluate(lookupFrom(features));
    expect(result.decisions.reviewOutcome).toEqual({ action: "enhancedReview", firedRuleIds: ["nsrp.highrisk.edd"] });
  });

  it("defaults to approve and rateLow when no rule fires", () => {
    const clean = generateBenchCases(1, 400).find((c) => evaluateCase(c).decisions.reviewOutcome?.firedRuleIds.length === 0);
    if (clean === undefined) throw new Error("no clean case in sample");
    expect(evaluateCase(clean).decisions.reviewOutcome?.action).toBe("approve");
    const unrated = generateBenchCases(2, 400).find((c) => evaluateCase(c).decisions.riskRating?.firedRuleIds.length === 0);
    expect(unrated && evaluateCase(unrated).decisions.riskRating).toEqual({ action: "rateLow", firedRuleIds: [] });
  });
});

describe("NSRP-1 exception scope", () => {
  const longstandingHighRisk = { customerStatus: "existing", accountAgeMonths: 36, sourceOfFunds: "verified", jurisdictionRisk: "high" } as const;

  it("lifts only the jurisdiction rule: an unverified large owner still goes to enhanced review", () => {
    const c = generateKycCase(mulberry32(11), {
      id: "NS-2026-9901",
      set: "practice",
      ...longstandingHighRisk,
      entityType: "company",
      uboOwnershipPct: 30,
      uboVerified: false,
      pep: false,
      sanctionsHit: false,
      adverseMedia: false,
    });
    const result = evaluateCase(c).decisions["reviewOutcome"];
    expect(result?.action).toBe("enhancedReview");
    expect(result?.firedRuleIds).toEqual(["nsrp.ubo.threshold", "nsrp.highrisk.longstanding"]);
  });

  it("approves the long-standing high-risk customer when nothing else applies", () => {
    const c = generateKycCase(mulberry32(12), {
      id: "NS-2026-9902",
      set: "practice",
      ...longstandingHighRisk,
      entityType: "company",
      uboOwnershipPct: 20,
      uboVerified: true,
      pep: false,
      sanctionsHit: false,
      adverseMedia: false,
    });
    expect(evaluateCase(c).decisions["reviewOutcome"]?.action).toBe("approve");
  });
});

/** Rules on features the benchmark's generator leaves neutral. */
const JUDGMENT_RULES = new Set([
  "nsrp.name.strong.escalate",
  "nsrp.name.strong.no_approve",
  "nsrp.media.serious",
  "nsrp.volume.inconsistent",
  "nsrp.structure.nominee",
  "nsrp.structure.layered",
  "nsrp.volume.elevated",
  "nsrp.name.weak.edd",
  "nsrp.sector.cash",
  "nsrp.sector.cash.established",
]);

describe("NSRP-1 on the bench distribution", () => {
  const SAMPLE = generateBenchCases(20261004, 2400);
  const results = SAMPLE.map(evaluateCase);

  it("has no equal-priority disagreement and never decides a forbidden action (2400 cases)", () => {
    const priority = new Map(KYC_HIDDEN_POLICY.rules.map((r) => [r.id, r.priority]));
    const recommends = new Map(
      KYC_HIDDEN_POLICY.rules.flatMap((r) => (r.effect.type === "recommend" ? [[r.id, r.effect.action] as const] : [])),
    );
    for (const result of results)
      for (const { action, firedRuleIds } of Object.values(result.decisions)) {
        expect(result.forbidden).not.toContain(action);
        const top = Math.max(...firedRuleIds.filter((id) => recommends.has(id)).map((id) => priority.get(id) ?? 0));
        const topActions = new Set(firedRuleIds.filter((id) => recommends.has(id) && priority.get(id) === top).map((id) => recommends.get(id)));
        expect(topActions.size).toBeLessThanOrEqual(1);
        if (topActions.size === 1) expect([...topActions][0]).toBe(action);
      }
  });

  it("fires every rule on a meaningful share of cases and reaches every review outcome", () => {
    const fired = new Map<string, number>(KYC_HIDDEN_POLICY.rules.map((r) => [r.id, 0]));
    const outcomes = new Map<string, number>();
    for (const result of results) {
      for (const { firedRuleIds } of Object.values(result.decisions)) for (const id of firedRuleIds) fired.set(id, (fired.get(id) ?? 0) + 1);
      const outcome = result.decisions.reviewOutcome?.action ?? "none";
      outcomes.set(outcome, (outcomes.get(outcome) ?? 0) + 1);
    }
    const pct = (n: number) => `${((100 * n) / SAMPLE.length).toFixed(1)}%`;
    console.info(
      `NSRP-1 bench distribution (${SAMPLE.length} cases)\n` +
        [...fired].map(([id, n]) => `  ${id.padEnd(28)} ${String(n).padStart(5)}  ${pct(n)}`).join("\n") +
        "\n  outcomes: " +
        [...outcomes].map(([a, n]) => `${a} ${pct(n)}`).join(", "),
    );
    // The bench sample draws the original eleven features only; the judgment rules are exercised by the curated cases below.
    for (const [id, n] of fired) if (!JUDGMENT_RULES.has(id)) expect(n / SAMPLE.length, id).toBeGreaterThanOrEqual(0.04);
    for (const id of JUDGMENT_RULES) expect(fired.get(id), id).toBe(0);
    for (const action of ["approve", "enhancedReview", "requestDocuments", "escalateCompliance", "reject"])
      expect(outcomes.get(action) ?? 0, action).toBeGreaterThanOrEqual(SAMPLE.length * 0.04);
  });
});

describe("NSRP-1 judgment cases: each carries a decision the screen does not state", () => {
  const byId = (id: string): KycCase => {
    const found = [...kycCases("training"), ...kycCases("heldout"), ...kycCases("practice")].find((c) => c.id === id);
    if (found === undefined) throw new Error(`no case ${id}`);
    return found;
  };
  const outcome = (id: string) => {
    const result = evaluateCase(byId(id));
    return { action: result.decisions.reviewOutcome?.action, fired: result.decisions.reviewOutcome?.firedRuleIds ?? [], forbidden: result.forbidden };
  };

  // [case, outcome, rule that decides it, why an expert's reasoning (not the screen) is what gets it right]
  const EXPECTED: readonly [string, string, string, string][] = [
    ["NS-2026-0104", "enhancedReview", "nsrp.sector.cash", "a cash business only eight months old has no track record: the exception needs 12 months"],
    ["NS-2026-0105", "approve", "nsrp.sector.cash.established", "the same business, established and consistent, is fine"],
    ["NS-2026-0106", "requestDocuments", "nsrp.structure.nominee", "the nominator declaration comes before any review"],
    ["NS-2026-0107", "escalateCompliance", "nsrp.name.strong.escalate", "date of birth and nationality align: never cleared at the desk"],
    ["NS-2026-0108", "escalateCompliance", "nsrp.media.serious", "bribery prosecution escalates even in a low-risk country"],
    ["NS-2026-0203", "requestDocuments", "nsrp.volume.inconsistent", "an established cash business expecting three times its declared turnover"],
    ["NS-2026-0204", "enhancedReview", "nsrp.structure.layered", "all owners verified, but a holding company sits above the customer"],
    ["NS-2026-0205", "approve", "", "a weak name match in a low-risk country is a routine false positive"],
    ["NS-2026-0206", "escalateCompliance", "nsrp.media.serious", "six years with the bank does not outweigh a fraud prosecution"],
  ];

  it.each(EXPECTED)("%s → %s (%s)", (id, action, rule, _why) => {
    const got = outcome(id);
    expect(got.action).toBe(action);
    if (rule !== "") expect(got.fired).toContain(rule);
    else expect(got.fired.filter((r) => !r.includes("rating"))).toEqual([]);
  });

  it("a strong name match forbids approval; the sanctions-list hit rejects", () => {
    expect(outcome("NS-2026-0107").forbidden).toContain("approve");
    expect(outcome("NS-2026-0202").action).toBe("reject");
  });

  it("the cash-business exception overrides only the sector rule: it never lifts anything else", () => {
    const established = byId("NS-2026-0105");
    const withPep = { ...established, owners: established.owners.map((o, i) => (i === 0 ? { ...o, pep: true } : o)) };
    expect(evaluateCase(withPep).decisions.reviewOutcome?.action).toBe("escalateCompliance");
    const nominee = { ...established, owners: established.owners.map((o, i) => (i === 0 ? { ...o, kind: "nominee" as const } : o)) };
    expect(evaluateCase(nominee).decisions.reviewOutcome?.action).toBe("requestDocuments");
    const young = { ...established, relationship: { ...established.relationship, accountAgeMonths: 11 } };
    expect(evaluateCase(young).decisions.reviewOutcome?.action).toBe("enhancedReview");
    const exactlyTwelve = { ...established, relationship: { ...established.relationship, accountAgeMonths: 12 } };
    expect(evaluateCase(exactlyTwelve).decisions.reviewOutcome?.action).toBe("approve");
  });

  it("the volume bands are 1.25x and 2.5x of declared turnover", () => {
    const base = byId("NS-2026-0105");
    const withVolume = (monthly: number): KycCase => ({ ...base, funds: { ...base.funds, expectedMonthlyVolumeEur: monthly } });
    // declared EUR 600,000 a year: 62,500 a month is exactly 1.25x, 125,000 exactly 2.5x.
    expect(caseFeatures(withVolume(62_500))["volumeConsistency" as never]).toBe("consistent");
    expect(caseFeatures(withVolume(62_501))["volumeConsistency" as never]).toBe("elevated");
    expect(caseFeatures(withVolume(125_000))["volumeConsistency" as never]).toBe("elevated");
    expect(caseFeatures(withVolume(125_001))["volumeConsistency" as never]).toBe("inconsistent");
    // elevated activity in a high-risk sector is enhanced review; inconsistent is documents.
    expect(evaluateCase(withVolume(100_000)).decisions.reviewOutcome?.action).toBe("enhancedReview");
    expect(evaluateCase(withVolume(130_000)).decisions.reviewOutcome?.action).toBe("requestDocuments");
  });

  it("no two recommendations with different actions ever share a priority", () => {
    const byPriority = new Map<number, Set<string>>();
    for (const r of KYC_HIDDEN_POLICY.rules)
      if (r.effect.type === "recommend") byPriority.set(r.priority, new Set([...(byPriority.get(r.priority) ?? []), `${r.decisionFamily}:${r.effect.action}`]));
    for (const [priority, actions] of byPriority) expect([...actions].length, `priority ${priority}: ${[...actions].join(", ")}`).toBe(1);
  });

  it("every training and held-out case has a deliberate, distinct reason: the set exercises every new rule", () => {
    const fired = new Set(
      [...kycCases("training"), ...kycCases("heldout")].flatMap((c) => evaluateCase(c).decisions.reviewOutcome?.firedRuleIds ?? []),
    );
    for (const id of [
      "nsrp.sector.cash",
      "nsrp.sector.cash.established",
      "nsrp.structure.nominee",
      "nsrp.structure.layered",
      "nsrp.name.strong.escalate",
      "nsrp.media.serious",
      "nsrp.volume.inconsistent",
    ])
      expect(fired, id).toContain(id);
  });
});
