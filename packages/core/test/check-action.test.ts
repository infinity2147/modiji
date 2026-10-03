import { describe, expect, it } from "vitest";
import {
  ActionIdSchema,
  ConfirmedRuleSchema,
  RulebookError,
  checkAction,
  unknown,
  type ConfirmedRule,
  type FeatureValue,
  type GuardrailResult,
} from "../src";
import { KYC_DOMAIN } from "../src/domains/kyc";
import { lookupFrom } from "./helpers";

type RuleSpec = {
  id: string;
  predicate: unknown;
  effect: unknown;
  family?: string;
  overrides?: string[];
  extraEvidence?: unknown[];
};

/** A confirmed rule with one supporting quote "quote:<id>" (parsed, so test fixtures are valid by construction). */
function rule({ id, predicate, effect, family = "reviewOutcome", overrides = [], extraEvidence = [] }: RuleSpec): ConfirmedRule {
  return ConfirmedRuleSchema.parse({
    id,
    decisionFamily: family,
    kind: "guardrail",
    predicate,
    effect,
    priority: 100,
    overrides,
    evidence: [quote(id, "supports"), ...extraEvidence],
    confirmedBy: [{ expertId: "expert-1", at: 1, method: "debrief", ledgerEntryId: `ledger-${id}` }],
    revision: 1,
    schemaVersion: 1,
    expertId: "expert-1",
  });
}

function quote(id: string, relation: "supports" | "contradicts") {
  return {
    kind: "expert_quote",
    utteranceId: `utt-${id}-${relation}`,
    exactQuote: `quote:${id}:${relation}`,
    t0Ms: 0,
    t1Ms: 1000,
    frameIds: [`frame-${id}`],
    eventIds: [],
    relation,
    provenance: "human_voice",
  };
}

const action = (id: string) => ActionIdSchema.parse(id);

const COMPLETE: Record<string, FeatureValue> = {
  entityType: "company",
  customerStatus: "new",
  accountAgeMonths: 0,
  jurisdictionRisk: "high",
  uboOwnershipPct: 30,
  uboVerified: true,
  pep: false,
  sanctionsHit: false,
  adverseMedia: false,
  sourceOfFunds: "verified",
  expectedMonthlyVolume: 65_000,
  riskRating: "unrated",
};

function check(rules: ConfirmedRule[], proposed: string, overrides: Record<string, FeatureValue> = {}): GuardrailResult {
  return checkAction({ rules, features: lookupFrom({ ...COMPLETE, ...overrides }), action: action(proposed), domain: KYC_DOMAIN });
}

const NOT_VISIBLE = unknown("not_visible");

const sanctionsForbid = rule({
  id: "r.sanctions",
  predicate: { "==": [{ var: "sanctionsHit" }, true] },
  effect: { type: "forbid", action: "approve" },
});
const highRiskForbid = rule({
  id: "r.highrisk",
  predicate: { "==": [{ var: "jurisdictionRisk" }, "high"] },
  effect: { type: "forbid", action: "approve" },
});
const longstandingException = rule({
  id: "r.longstanding",
  predicate: {
    and: [{ "==": [{ var: "customerStatus" }, "existing"] }, { ">=": [{ var: "accountAgeMonths" }, 24] }],
  },
  effect: { type: "recommend", action: "approve" },
  overrides: ["r.highrisk"],
});
const pepApproval = rule({
  id: "r.pep",
  predicate: { "==": [{ var: "pep" }, true] },
  effect: { type: "require_approval", role: "compliance_officer" },
  extraEvidence: [quote("r.pep-extra", "supports"), quote("r.pep-counter", "contradicts"), { kind: "observed_decision", ledgerEntryId: "l-9" }],
});
const ALLOW: GuardrailResult = { decision: "allow", matchedRules: [], missingFeatures: [], evidence: [] };

describe("checkAction precedence", () => {
  it("allows anything under an empty rulebook", () => {
    for (const a of KYC_DOMAIN.actions) expect(check([], a.id)).toEqual(ALLOW);
  });

  it("forbid true → forbid, with the matched rules' supporting quotes", () => {
    const result = check([sanctionsForbid, highRiskForbid, pepApproval], "approve", { sanctionsHit: true, pep: true });
    expect(result).toEqual({
      decision: "forbid",
      matchedRules: ["r.highrisk", "r.sanctions"],
      missingFeatures: [],
      evidence: [highRiskForbid.evidence[0], sanctionsForbid.evidence[0]],
    });
  });

  it("forbid true beats forbid unknown", () => {
    const result = check([sanctionsForbid, highRiskForbid], "approve", { sanctionsHit: NOT_VISIBLE });
    expect(result.decision).toBe("forbid");
    expect(result.matchedRules).toEqual(["r.highrisk"]);
  });

  it("forbid unknown → insufficient_information, even when an approval rule is true", () => {
    const result = check([sanctionsForbid, pepApproval], "approve", { sanctionsHit: NOT_VISIBLE, pep: true });
    expect(result).toEqual({
      decision: "insufficient_information",
      matchedRules: ["r.sanctions"],
      missingFeatures: ["sanctionsHit"],
      evidence: [sanctionsForbid.evidence[0]],
    });
  });

  it("require_approval true → needs_approval; evidence keeps only supporting quotes", () => {
    const result = check([sanctionsForbid, pepApproval], "approve", { pep: true });
    expect(result).toEqual({
      decision: "needs_approval",
      matchedRules: ["r.pep"],
      missingFeatures: [],
      evidence: [quote("r.pep", "supports"), quote("r.pep-extra", "supports")],
    });
  });

  it("require_approval unknown → insufficient_information", () => {
    const result = check([sanctionsForbid, pepApproval], "approve", { pep: NOT_VISIBLE });
    expect(result).toMatchObject({ decision: "insufficient_information", matchedRules: ["r.pep"], missingFeatures: ["pep"] });
  });

  it("all participating rules false → allow", () => {
    expect(check([sanctionsForbid, pepApproval], "approve", { jurisdictionRisk: "low" })).toEqual(ALLOW);
  });

  it("missingFeatures is the sorted, de-duplicated union over the undetermined rules", () => {
    const ubo = rule({
      id: "r.ubo",
      predicate: { and: [{ ">": [{ var: "uboOwnershipPct" }, 25] }, { "==": [{ var: "uboVerified" }, false] }] },
      effect: { type: "forbid", action: "approve" },
    });
    const media = rule({
      id: "r.media",
      predicate: { or: [{ "==": [{ var: "adverseMedia" }, true] }, { "==": [{ var: "uboVerified" }, false] }] },
      effect: { type: "forbid", action: "approve" },
    });
    const result = check([ubo, media], "approve", { uboVerified: NOT_VISIBLE, uboOwnershipPct: NOT_VISIBLE, adverseMedia: false });
    expect(result).toMatchObject({
      decision: "insufficient_information",
      matchedRules: ["r.media", "r.ubo"],
      missingFeatures: ["uboOwnershipPct", "uboVerified"],
    });
  });
});

describe("checkAction participation", () => {
  it("forbid constrains only its own action", () => {
    expect(check([sanctionsForbid], "reject", { sanctionsHit: true })).toEqual(ALLOW);
    expect(check([sanctionsForbid], "approve", { sanctionsHit: true }).decision).toBe("forbid");
  });

  it("require_approval constrains exactly the actions of its decision family", () => {
    const ratingApproval = rule({
      id: "r.rating",
      family: "riskRating",
      predicate: { "==": [{ var: "pep" }, true] },
      effect: { type: "require_approval", role: "compliance_officer" },
    });
    for (const a of ["rateLow", "rateMedium", "rateHigh"])
      expect(check([ratingApproval], a, { pep: true }).decision).toBe("needs_approval");
    for (const a of ["approve", "reject", "enhancedReview"]) expect(check([ratingApproval], a, { pep: true })).toEqual(ALLOW);
  });

  it("recommend and route effects never block", () => {
    const recommend = rule({ id: "r.rec", predicate: { "==": [{ var: "sanctionsHit" }, true] }, effect: { type: "recommend", action: "reject" } });
    const route = rule({ id: "r.route", predicate: { "==": [{ var: "sanctionsHit" }, true] }, effect: { type: "route", destination: "mlro" } });
    for (const a of KYC_DOMAIN.actions) {
      expect(check([recommend, route], a.id, { sanctionsHit: true })).toEqual(ALLOW);
      expect(check([recommend, route], a.id, { sanctionsHit: NOT_VISIBLE })).toEqual(ALLOW);
    }
  });
});

describe("checkAction overrides", () => {
  const rules = [highRiskForbid, longstandingException];

  it("a true overrider suppresses the rule", () => {
    expect(check(rules, "approve", { customerStatus: "existing", accountAgeMonths: 36 })).toEqual(ALLOW);
  });

  it("a true overrider suppresses even a rule whose own truth is unknown", () => {
    expect(check(rules, "approve", { customerStatus: "existing", accountAgeMonths: 36, jurisdictionRisk: NOT_VISIBLE })).toEqual(ALLOW);
  });

  it("a false overrider leaves the rule in force", () => {
    expect(check(rules, "approve", { customerStatus: "existing", accountAgeMonths: 12 }).decision).toBe("forbid");
  });

  it("an unknown overrider does not suppress: never allow, and the overrider's missing features are reported", () => {
    const result = check(rules, "approve", { customerStatus: "existing", accountAgeMonths: NOT_VISIBLE });
    expect(result).toEqual({
      decision: "insufficient_information",
      matchedRules: ["r.highrisk"],
      missingFeatures: ["accountAgeMonths"],
      evidence: [highRiskForbid.evidence[0]],
    });
  });

  it("an overrider in another family still suppresses", () => {
    const ratingException = rule({ ...longstandingSpec(), id: "r.rating-exception", family: "riskRating" });
    expect(check([highRiskForbid, ratingException], "approve", { customerStatus: "existing", accountAgeMonths: 36 })).toEqual(ALLOW);
  });
});

function longstandingSpec(): RuleSpec {
  return {
    id: "r.longstanding",
    predicate: { and: [{ "==": [{ var: "customerStatus" }, "existing"] }, { ">=": [{ var: "accountAgeMonths" }, 24] }] },
    effect: { type: "recommend", action: "rateLow" },
    overrides: ["r.highrisk"],
  };
}

describe("checkAction input errors", () => {
  it("throws a RulebookError naming every ill-typed or dangling rule", () => {
    const bad = [
      rule({ id: "bad.type", predicate: { ">": [{ var: "pep" }, 1] }, effect: { type: "forbid", action: "approve" } }),
      rule({ id: "bad.feature", predicate: { "==": [{ var: "shoeSize" }, 1] }, effect: { type: "forbid", action: "approve" } }),
      rule({ id: "bad.family", family: "payments", predicate: { "==": [{ var: "pep" }, true] }, effect: { type: "forbid", action: "approve" } }),
      rule({ id: "bad.action", predicate: { "==": [{ var: "pep" }, true] }, effect: { type: "forbid", action: "launder" } }),
      sanctionsForbid,
      sanctionsForbid,
    ];
    let error: unknown;
    try {
      check(bad, "approve");
    } catch (e) {
      error = e;
    }
    expect(error).toBeInstanceOf(RulebookError);
    const issues = (error as RulebookError).issues.join("\n");
    for (const fragment of ["bad.type", "bad.feature", "shoeSize", 'unknown decision family "payments"', 'unknown action "launder"', '"r.sanctions": duplicate id'])
      expect(issues).toContain(fragment);
  });

  it("rejects an action the domain does not declare", () => {
    expect(() => check([], "launder")).toThrow(RangeError);
  });
});
