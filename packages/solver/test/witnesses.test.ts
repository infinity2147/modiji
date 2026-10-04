import {
  FeatureIdSchema,
  PredicateSchema,
  RuleEffectSchema,
  WitnessSchema,
  evaluatePredicate,
  loadDomainConfig,
  type Assignment,
  type FeatureLookup,
  type Predicate,
  type Witness,
} from "@vashistha/core";
import { DEFAULT_BENCH_SEED, KYC_DOMAIN, caseFeatures, generateBenchCases } from "@vashistha/core/domains/kyc";
import { KYC_HIDDEN_POLICY } from "@vashistha/core/domains/kyc/oracle";
import { describe, expect, it } from "vitest";
import {
  SolverInputError,
  UNRESOLVED,
  effectiveDecision,
  equivalent,
  findBoundaries,
  findConflicts,
  findContrasts,
  findDisagreements,
  findUnresolved,
  practiceCases,
  prepareRulebook,
  type ContrastWitness,
  type SolverRule,
} from "../src/index";

const P = (json: unknown): Predicate => PredicateSchema.parse(json);
const v = (id: string) => ({ var: id });
const recommend = (action: string) => RuleEffectSchema.parse({ type: "recommend", action });

function rule(
  id: string,
  predicate: unknown,
  effect: SolverRule["effect"],
  priority: number,
  extra: { family?: string; overrides?: string[]; kind?: SolverRule["kind"] } = {},
): SolverRule {
  return {
    id,
    decisionFamily: extra.family ?? "reviewOutcome",
    kind: extra.kind ?? "decision",
    predicate: P(predicate),
    effect,
    priority,
    overrides: extra.overrides ?? [],
  };
}

// Fixture rulebook modelled on plan §10.
const UBO = rule("ubo", { and: [{ "!=": [v("entityType"), "individual"] }, { ">": [v("uboOwnershipPct"), 25] }] }, recommend("enhancedReview"), 60);
const HIGH = rule("highrisk", { "==": [v("jurisdictionRisk"), "high"] }, recommend("enhancedReview"), 60);
const LONG = rule(
  "longstanding",
  {
    and: [
      { "==": [v("customerStatus"), "existing"] },
      { ">=": [v("accountAgeMonths"), 24] },
      { "==": [v("sourceOfFunds"), "verified"] },
      { "==": [v("jurisdictionRisk"), "high"] },
    ],
  },
  recommend("approve"),
  70,
  { overrides: ["highrisk"], kind: "exception" },
);
const PEP = rule("pep", { "==": [v("pep"), true] }, recommend("escalateCompliance"), 90, { kind: "escalation" });
const SANCTIONS = rule("sanctions", { "==": [v("sanctionsHit"), true] }, RuleEffectSchema.parse({ type: "forbid", action: "approve" }), 100, {
  kind: "guardrail",
});
const FIXTURE = [UBO, HIGH, LONG, PEP, SANCTIONS];

const base = { domain: KYC_DOMAIN, schemaVersion: 1 };
const lookupOf =
  (a: Assignment): FeatureLookup =>
  (id) => {
    const value = a[id];
    if (value === undefined) throw new Error(`missing ${id}`);
    return value;
  };
const at = (a: Assignment, id: string) => a[FeatureIdSchema.parse(id)];
const holds = (p: Predicate, a: Assignment) => evaluatePredicate(p, lookupOf(a)).truth === true;

function expectValidKycCase(w: Witness): void {
  expect(WitnessSchema.parse(w)).toEqual(w);
  const a = w.assignment;
  for (const c of KYC_DOMAIN.domainConstraints) expect(holds(c, a)).toBe(true);
  if (at(a, "entityType") === "individual") expect(at(a, "uboOwnershipPct")).toBe(100);
  if (at(a, "customerStatus") === "new") expect(at(a, "accountAgeMonths")).toBe(0);
  else expect(at(a, "accountAgeMonths")).toBeGreaterThanOrEqual(1);
}

const familyOf = (id: string) => {
  const f = KYC_DOMAIN.decisionFamilies.find((x) => x.id === id);
  if (f === undefined) throw new Error(id);
  return f;
};
const REVIEW = familyOf("reviewOutcome");

describe("findUnresolved", () => {
  it("finds distinct valid unresolved cases when the rulebook has a gap", async () => {
    const ws = await findUnresolved({ ...base, rules: FIXTURE, family: "reviewOutcome", limit: 5 });
    expect(ws).toHaveLength(5);
    const book = prepareRulebook(KYC_DOMAIN, FIXTURE);
    for (const w of ws) {
      expectValidKycCase(w);
      expect(w.kind).toBe("unresolved");
      expect(effectiveDecision(book, REVIEW, lookupOf(w.assignment)).kind).toBe("unresolved");
    }
    expect(new Set(ws.map((w) => w.id)).size).toBe(5);
    expect(new Set(ws.map((w) => JSON.stringify(w.assignment))).size).toBe(5);
    // Canonical values: the first witness is the "smallest" valid unresolved case.
    expect(ws[0]?.assignment).toMatchObject({ entityType: "individual", customerStatus: "new", accountAgeMonths: 0, uboOwnershipPct: 100, pep: false });
  });

  it("respects the limit and enumerates every cell once", async () => {
    expect(await findUnresolved({ ...base, rules: FIXTURE, family: "reviewOutcome", limit: 2 })).toHaveLength(2);
    // Gap cells of the fixture are finite: the enumeration terminates below a large limit.
    const all = await findUnresolved({ ...base, rules: FIXTURE, family: "reviewOutcome", limit: 200 });
    expect(all.length).toBeLessThan(200);
  });

  it("finds none when complementary rules cover the family", async () => {
    const rules = [
      rule("high", { "==": [v("jurisdictionRisk"), "high"] }, recommend("enhancedReview"), 60),
      rule("notHigh", { "!=": [v("jurisdictionRisk"), "high"] }, recommend("approve"), 10),
    ];
    expect(await findUnresolved({ ...base, rules, family: "reviewOutcome" })).toEqual([]);
  });

  it("uses the domain constraints: gaps that only invalid cases could reach are not reported", async () => {
    const rules = [
      // Only an individual with a share other than 100 % (invalid) escapes these two rules.
      rule("whole", { "==": [v("uboOwnershipPct"), 100] }, recommend("approve"), 10),
      rule("entity", { "!=": [v("entityType"), "individual"] }, recommend("enhancedReview"), 10),
    ];
    expect(await findUnresolved({ ...base, rules, family: "reviewOutcome" })).toEqual([]);
    const ages = [
      // Only a new customer with a relationship age (invalid) escapes these two rules.
      rule("fresh", { "==": [v("accountAgeMonths"), 0] }, recommend("requestDocuments"), 10),
      rule("existing", { "==": [v("customerStatus"), "existing"] }, recommend("approve"), 10),
    ];
    expect(await findUnresolved({ ...base, rules: ages, family: "reviewOutcome" })).toEqual([]);
  });

  it("an overridden rule does not resolve the case", async () => {
    const rules = [
      rule("high", { "==": [v("jurisdictionRisk"), "high"] }, recommend("enhancedReview"), 60),
      rule("notHigh", { "!=": [v("jurisdictionRisk"), "high"] }, recommend("approve"), 10),
      // Another family's rule overrides `notHigh` whenever pep is true.
      rule("pepRating", { "==": [v("pep"), true] }, recommend("rateHigh"), 5, { family: "riskRating", overrides: ["notHigh"] }),
    ];
    const ws = await findUnresolved({ ...base, rules, family: "reviewOutcome", limit: 10 });
    expect(ws.length).toBeGreaterThan(0);
    for (const w of ws) expect(w.assignment).toMatchObject({ pep: true });
    for (const w of ws) expect(at(w.assignment, "jurisdictionRisk")).not.toBe("high");
  });

  it("returns one witness for an empty rulebook and rejects malformed rules", async () => {
    expect(await findUnresolved({ ...base, rules: [], family: "riskRating" })).toHaveLength(1);
    const bad = rule("bad", { "==": [v("jurisdictionRisk"), "high"] }, recommend("rateHigh"), 1);
    await expect(findUnresolved({ ...base, rules: [bad], family: "reviewOutcome" })).rejects.toThrow(SolverInputError);
    await expect(findUnresolved({ ...base, rules: [], family: "nope" })).rejects.toThrow(SolverInputError);
    await expect(findUnresolved({ ...base, rules: [], family: "reviewOutcome", limit: 0 })).rejects.toThrow(SolverInputError);
  });
});

describe("findConflicts", () => {
  const high = rule("high", { "==": [v("jurisdictionRisk"), "high"] }, recommend("enhancedReview"), 60);
  const pepApprove = rule("pepApprove", { "==": [v("pep"), true] }, recommend("escalateCompliance"), 60);
  const family = "reviewOutcome";

  it("equal priority + different actions → conflict", async () => {
    const ws = await findConflicts({ ...base, rules: [pepApprove, high], family });
    expect(ws).toHaveLength(1);
    const [w] = ws;
    expect(w).toMatchObject({ kind: "conflict", ruleIds: ["high", "pepApprove"], actions: ["enhancedReview", "escalateCompliance"] });
    if (w === undefined) return;
    expectValidKycCase(w);
    expect(w.assignment).toMatchObject({ jurisdictionRisk: "high", pep: true });
  });

  it("an override edge removes the pair (either direction)", async () => {
    expect(await findConflicts({ ...base, rules: [high, { ...pepApprove, overrides: ["high"] }], family })).toEqual([]);
    expect(await findConflicts({ ...base, rules: [{ ...high, overrides: ["pepApprove"] }, pepApprove], family })).toEqual([]);
  });

  it("different priorities never conflict", async () => {
    expect(await findConflicts({ ...base, rules: [high, { ...pepApprove, priority: 61 }], family })).toEqual([]);
  });

  it("a guardrail firing alongside a decision is not a conflict", async () => {
    const forbid = rule("noApprove", { "==": [v("jurisdictionRisk"), "high"] }, RuleEffectSchema.parse({ type: "forbid", action: "enhancedReview" }), 60, {
      kind: "guardrail",
    });
    expect(await findConflicts({ ...base, rules: [high, forbid], family })).toEqual([]);
  });

  it("the same action is not a conflict", async () => {
    expect(await findConflicts({ ...base, rules: [high, { ...pepApprove, effect: recommend("enhancedReview") }], family })).toEqual([]);
  });

  it("a rule overridden by a firing rule does not count as firing", async () => {
    const pepHigh = rule("pepHigh", { and: [{ "==": [v("pep"), true] }, { "==": [v("jurisdictionRisk"), "high"] }] }, recommend("approve"), 60);
    expect(await findConflicts({ ...base, rules: [high, pepHigh], family })).toHaveLength(1);
    // Another family's rule suppresses `high` whenever pep is true, so `high` never fires with `pepHigh`.
    const suppress = rule("pepRating", { "==": [v("pep"), true] }, recommend("rateHigh"), 5, { family: "riskRating", overrides: ["high"] });
    expect(await findConflicts({ ...base, rules: [high, pepHigh, suppress], family })).toEqual([]);
  });

  it("a tie shadowed by a firing higher-priority decision is not a conflict", async () => {
    const pepHigh = rule("pepHigh", { and: [{ "==": [v("pep"), true] }, { "==": [v("jurisdictionRisk"), "high"] }] }, recommend("approve"), 60);
    const top = rule("top", { "==": [v("jurisdictionRisk"), "high"] }, recommend("escalateCompliance"), 90);
    expect(await findConflicts({ ...base, rules: [high, pepHigh, top], family })).toEqual([]);
  });

  it("finds no equal-priority conflict in the KYC hidden policy", async () => {
    for (const f of KYC_DOMAIN.decisionFamilies) expect(await findConflicts({ ...base, rules: KYC_HIDDEN_POLICY.rules, family: f.id })).toEqual([]);
  });
});

describe("findBoundaries", () => {
  it("real threshold: 24.9 / 25 / 25.1 where the comparison is pivotal", async () => {
    const ws = await findBoundaries({ ...base, rules: FIXTURE, ruleId: "ubo" });
    expect(ws.map((w) => [w.side, w.feature, w.threshold, at(w.assignment, "uboOwnershipPct")])).toEqual([
      ["below", "uboOwnershipPct", 25, 24.9],
      ["at", "uboOwnershipPct", 25, 25],
      ["above", "uboOwnershipPct", 25, 25.1],
    ]);
    for (const w of ws) {
      expectValidKycCase(w);
      expect(at(w.assignment, "entityType")).not.toBe("individual");
      expect(holds(UBO.predicate, w.assignment)).toBe(w.side === "above");
    }
  });

  it("integer threshold: 23 / 24 / 25 months with the rest of the exception satisfied", async () => {
    const ws = await findBoundaries({ ...base, rules: FIXTURE, ruleId: "longstanding" });
    expect(ws.map((w) => [w.side, at(w.assignment, "accountAgeMonths")])).toEqual([
      ["below", 23],
      ["at", 24],
      ["above", 25],
    ]);
    for (const w of ws) {
      expectValidKycCase(w);
      expect(w.assignment).toMatchObject({ customerStatus: "existing", sourceOfFunds: "verified", jurisdictionRisk: "high" });
      expect(holds(LONG.predicate, w.assignment)).toBe(w.side !== "below");
    }
  });

  it("omits sides outside the feature's bounds and rejects unknown rules", async () => {
    const atMax = rule("full", { ">=": [v("uboOwnershipPct"), 100] }, recommend("enhancedReview"), 1);
    const ws = await findBoundaries({ ...base, rules: [atMax], ruleId: "full" });
    expect(ws.map((w) => w.side)).toEqual(["below", "at"]);
    await expect(findBoundaries({ ...base, rules: FIXTURE, ruleId: "missing" })).rejects.toThrow(SolverInputError);
  });

  it("practice cases interleave the weakest rules round-robin", async () => {
    const ws = await practiceCases({ ...base, rules: FIXTURE, ruleIds: ["ubo", "longstanding"], count: 4 });
    expect(ws.map((w) => [w.ruleId, w.kind === "boundary" ? w.side : w.kind])).toEqual([
      ["ubo", "below"],
      ["longstanding", "below"],
      ["ubo", "at"],
      ["longstanding", "at"],
    ]);
    for (const w of ws) if (w.kind === "boundary") expectValidKycCase(w);
  });
});

/** The leaf conditions of an `and` of comparisons that are false on `a`. */
const falseConjuncts = (p: Predicate, a: Assignment): Predicate[] => ("and" in p ? p.and : [p]).filter((c) => !holds(c, a));

function expectSoundContrast(w: ContrastWitness, rules: readonly SolverRule[]): void {
  expect(w.kind).toBe("contrast");
  expect(w.id).toMatch(/^w_contrast_[0-9a-f]{24}$/);
  const { id, decisionFamily, assignment, schemaVersion } = w;
  expectValidKycCase({ kind: "unresolved", id, decisionFamily, assignment, schemaVersion }); // the base fields are schema-valid, the case valid
  const target = rules.find((r) => r.id === w.ruleId)!;
  expect(holds(target.predicate, w.assignment)).toBe(w.fires);
  const book = prepareRulebook(KYC_DOMAIN, rules);
  for (const o of rules.filter((r) => r.overrides.includes(w.ruleId))) expect(holds(o.predicate, w.assignment)).toBe(false);
  expect(book.byId.get(w.ruleId)).toBeDefined();
}

describe("findContrasts / practice cases without numeric thresholds", () => {
  // Boolean, enum and `in` conditions only: no threshold, so no boundary cases.
  const PEP_COMPANY = rule(
    "pepCompany",
    { and: [{ "==": [v("pep"), true] }, { in: [v("entityType"), ["company", "trust"]] }, { "!=": [v("sourceOfFunds"), "verified"] }] },
    recommend("escalateCompliance"),
    80,
  );
  const BOOK = [PEP_COMPANY, HIGH, LONG, SANCTIONS];

  it("each condition is pivotal in a valid, non-overridden case where the rule fires and one where it just misses", async () => {
    const ws = await findContrasts({ ...base, rules: BOOK, ruleId: "pepCompany", limit: 6 });
    // Round 1: (pep, fires), (pep, misses), (entityType, …), (sourceOfFunds, …) — every witness in its own decision cell.
    expect(ws.map((w) => [w.feature, w.fires])).toEqual([
      ["pep", true],
      ["pep", false],
      ["entityType", true],
      ["entityType", false],
      ["sourceOfFunds", true],
      ["sourceOfFunds", false],
    ]);
    for (const w of ws) {
      expectSoundContrast(w, BOOK);
      // In an `and`, a condition is pivotal iff every other conjunct holds.
      const off = falseConjuncts(PEP_COMPANY.predicate, w.assignment);
      if (w.fires) expect(off).toEqual([]);
      else expect(off.map((c) => Object.values(c)[0][0].var)).toEqual([w.feature]);
    }
    expect(new Set(ws.map((w) => JSON.stringify(w.assignment))).size).toBe(ws.length);
    expect(new Set(ws.map((w) => w.id)).size).toBe(ws.length);
  });

  it("an overridden rule is practised only where it is not overridden", async () => {
    const ws = await findContrasts({ ...base, rules: BOOK, ruleId: "highrisk", limit: 8 });
    expect(ws.length).toBeGreaterThanOrEqual(2);
    expect(ws.slice(0, 2).map((w) => [w.feature, w.fires])).toEqual([
      ["jurisdictionRisk", true],
      ["jurisdictionRisk", false],
    ]);
    for (const w of ws) {
      expectSoundContrast(w, BOOK);
      expect(holds(LONG.predicate, w.assignment)).toBe(false);
    }
    // Later rounds: the same contrast in other decision cells (other rules' conditions changed).
    expect(new Set(ws.map((w) => JSON.stringify(w.assignment))).size).toBe(ws.length);
  });

  it("practiceCases returns verified contrast cases when the weakest rules have no thresholds; longer lists extend shorter ones", async () => {
    const three = await practiceCases({ ...base, rules: BOOK, ruleIds: ["pepCompany", "sanctions"], count: 3 });
    expect(three).toHaveLength(3);
    expect(three.map((w) => [w.kind, w.ruleId])).toEqual([
      ["contrast", "pepCompany"],
      ["contrast", "sanctions"],
      ["contrast", "pepCompany"],
    ]);
    for (const w of three) expectSoundContrast(w as ContrastWitness, BOOK);
    const nine = await practiceCases({ ...base, rules: BOOK, ruleIds: ["pepCompany", "sanctions"], count: 9 });
    expect(nine.slice(0, 3)).toEqual(three);
    expect(nine.length).toBeGreaterThan(3);
    expect(new Set(nine.map((w) => JSON.stringify(w.assignment))).size).toBe(nine.length);
    for (const w of nine) if (w.kind === "contrast") expectSoundContrast(w, BOOK);
    expect(await practiceCases({ ...base, rules: BOOK, ruleIds: ["pepCompany", "sanctions"], count: 9 })).toEqual(nine);
  });

  it("a rule's boundary cases come first, then contrast cases in other cells", async () => {
    const ws = await practiceCases({ ...base, rules: FIXTURE, ruleIds: ["ubo"], count: 6 });
    expect(ws.map((w) => (w.kind === "boundary" ? w.side : `${w.feature}:${w.fires}`)).slice(0, 4)).toEqual(["below", "at", "above", "entityType:true"]);
    for (const w of ws) if (w.kind === "contrast") expectSoundContrast(w, FIXTURE);
    expect(new Set(ws.map((w) => JSON.stringify(w.assignment))).size).toBe(ws.length);
  });

  it("falls back to fires / does not fire when no condition can be pivotal, and rejects unknown rules", async () => {
    // Where `twice` is not overridden, pep is true and both (equal) conditions hold: neither is pivotal.
    const twice = rule("twice", { or: [{ "==": [v("pep"), true] }, { "==": [v("pep"), true] }] }, recommend("escalateCompliance"), 10);
    const unless = rule("unless", { "==": [v("pep"), false] }, recommend("approve"), 20, { overrides: ["twice"], kind: "exception" });
    const ws = await findContrasts({ ...base, rules: [twice, unless], ruleId: "twice" });
    expect(ws.length).toBeGreaterThanOrEqual(1);
    // Only "fires" exists; later cases vary the other conditions of the case (entity type, customer status, …).
    for (const w of ws) {
      expect([w.feature, w.fires, at(w.assignment, "pep")]).toEqual(["pep", true, true]);
      expectSoundContrast(w, [twice, unless]);
    }
    expect(new Set(ws.map((w) => JSON.stringify(w.assignment))).size).toBe(ws.length);
    await expect(findContrasts({ ...base, rules: FIXTURE, ruleId: "missing" })).rejects.toThrow(SolverInputError);
  });
});

describe("findDisagreements", () => {
  const experts = ["sabine", "lena"] as const;

  it("finds the exception one expert has and the other lacks", async () => {
    const withoutException = FIXTURE.filter((r) => r.id !== "longstanding");
    const ws = await findDisagreements({ ...base, rulesA: FIXTURE, rulesB: withoutException, experts, family: "reviewOutcome" });
    expect(ws).toHaveLength(1);
    const [w] = ws;
    expect(w).toMatchObject({ kind: "disagreement", experts: ["sabine", "lena"], actions: ["approve", "enhancedReview"] });
    if (w === undefined) return;
    expectValidKycCase(w);
    expect(w.assignment).toMatchObject({ customerStatus: "existing", accountAgeMonths: 24, sourceOfFunds: "verified", jurisdictionRisk: "high" });
  });

  it("reports an unresolved side as the action label 'unresolved'", async () => {
    const withoutPep = FIXTURE.filter((r) => r.id !== "pep");
    const ws = await findDisagreements({ ...base, rulesA: FIXTURE, rulesB: withoutPep, experts, family: "reviewOutcome" });
    expect(ws.map((w) => w.actions).sort()).toEqual([
      ["escalateCompliance", "approve"],
      ["escalateCompliance", "enhancedReview"],
      ["escalateCompliance", UNRESOLVED],
    ]);
  });

  it("finds none for identical rulebooks", async () => {
    expect(await findDisagreements({ ...base, rulesA: FIXTURE, rulesB: [...FIXTURE], experts, family: "reviewOutcome" })).toEqual([]);
  });
});

describe("equivalent", () => {
  const gt = P({ ">": [v("uboOwnershipPct"), 25] });

  it("ownership > 25 ≡ !(ownership <= 25), but not ≡ ownership >= 25 (counterexample 25)", async () => {
    expect(await equivalent({ domain: KYC_DOMAIN, a: gt, b: P({ "!": [{ "<=": [v("uboOwnershipPct"), 25] }] }) })).toEqual({ equivalent: true });
    const r = await equivalent({ domain: KYC_DOMAIN, a: gt, b: P({ ">=": [v("uboOwnershipPct"), 25] }) });
    expect(r.equivalent).toBe(false);
    if (!r.equivalent) expect(at(r.counterexample, "uboOwnershipPct")).toBe(25);
  });

  it("enum equivalences", async () => {
    const notLow = P({ "!=": [v("jurisdictionRisk"), "low"] });
    expect(await equivalent({ domain: KYC_DOMAIN, a: P({ in: [v("jurisdictionRisk"), ["medium", "high"]] }), b: notLow })).toEqual({ equivalent: true });
    const r = await equivalent({ domain: KYC_DOMAIN, a: P({ "==": [v("jurisdictionRisk"), "high"] }), b: notLow });
    expect(r).toMatchObject({ equivalent: false, counterexample: { jurisdictionRisk: "medium" } });
  });

  it("is relative to the domain constraints", async () => {
    expect(await equivalent({ domain: KYC_DOMAIN, a: P({ "==": [v("customerStatus"), "new"] }), b: P({ "==": [v("accountAgeMonths"), 0] }) })).toEqual({
      equivalent: true,
    });
    const individual = P({ "==": [v("entityType"), "individual"] });
    expect(await equivalent({ domain: KYC_DOMAIN, a: individual, b: P({ and: [individual, { "==": [v("uboOwnershipPct"), 100] }] }) })).toEqual({
      equivalent: true,
    });
  });

  it("encodes string features, feature-to-feature comparisons and mixed Int/Real exactly", async () => {
    const domain = loadDomainConfig({
      id: "toy",
      title: "Toy",
      features: [
        { id: "name", label: "Name", source: "case", type: "string" },
        { id: "alias", label: "Alias", source: "case", type: "string" },
        { id: "colour", label: "Colour", source: "case", type: "enum", values: ["red", "green", "blue"] },
        { id: "shade", label: "Shade", source: "case", type: "enum", values: ["blue", "green", "red"] },
        { id: "count", label: "Count", source: "case", type: "number", min: 0, max: 10, integer: true },
        { id: "level", label: "Level", source: "case", type: "number", min: 0, max: 10, integer: false },
      ],
      actions: [{ id: "ok", label: "OK", terminal: true }],
      decisionFamilies: [{ id: "f", label: "F", actions: ["ok"] }],
      domainConstraints: [],
      criticalFields: [],
    });
    const eq = (a: unknown, b: unknown) => equivalent({ domain, a: P(a), b: P(b) });
    expect(await eq({ "==": [v("name"), "Ann"] }, { in: [v("name"), ["Ann"]] })).toEqual({ equivalent: true });
    const other = await eq({ "!=": [v("name"), "Ann"] }, { "==": [v("name"), "Bob"] });
    expect(other.equivalent).toBe(false);
    if (!other.equivalent) expect(["Ann", "Bob"]).not.toContain(at(other.counterexample, "name"));
    expect(await eq({ "==": [v("name"), v("alias")] }, { "!": [{ "!=": [v("name"), v("alias")] }] })).toEqual({ equivalent: true });
    expect((await eq({ "==": [v("name"), v("alias")] }, { "==": [v("name"), "Ann"] })).equivalent).toBe(false);
    // Enum features with different value orders compare by value name.
    expect(await eq({ "==": [v("colour"), v("shade")] }, { or: [{ and: [{ "==": [v("colour"), "red"] }, { "==": [v("shade"), "red"] }] }, { and: [{ "==": [v("colour"), "green"] }, { "==": [v("shade"), "green"] }] }, { and: [{ "==": [v("colour"), "blue"] }, { "==": [v("shade"), "blue"] }] }] })).toEqual({ equivalent: true });
    // An integer count above a real level that is above 2.5: count ≥ 3 (and the converse fails at level ≥ count).
    expect(await eq({ and: [{ ">": [v("count"), v("level")] }, { ">": [v("level"), 2.5] }] }, { and: [{ ">": [v("count"), v("level")] }, { ">": [v("level"), 2.5] }, { ">=": [v("count"), 3] }] })).toEqual({ equivalent: true });
    const mixed = await eq({ ">": [v("count"), v("level")] }, { ">=": [v("count"), 3] });
    expect(mixed.equivalent).toBe(false);
  });
});

describe("hidden-policy parity", () => {
  it("effective decisions reproduce KYC_HIDDEN_POLICY.evaluate on 400 bench cases", () => {
    const book = prepareRulebook(KYC_DOMAIN, KYC_HIDDEN_POLICY.rules);
    const defaults: Record<string, string> = { reviewOutcome: "approve", riskRating: "rateLow" };
    const cases = generateBenchCases(DEFAULT_BENCH_SEED, 400);
    const seen = new Set<string>();
    for (const c of cases) {
      const features = caseFeatures(c);
      const lookup: FeatureLookup = (id) => {
        const value = features[id];
        if (value === undefined) throw new Error(id);
        return value;
      };
      const oracle = KYC_HIDDEN_POLICY.evaluate(lookup);
      for (const family of KYC_DOMAIN.decisionFamilies) {
        const eff = effectiveDecision(book, family, lookup);
        expect(eff.kind).not.toBe("conflict");
        const action = eff.kind === "decided" ? eff.outcome.label : defaults[family.id];
        expect(action, `${c.id} ${family.id}`).toBe(oracle.decisions[family.id]?.action);
        seen.add(`${family.id}:${eff.kind === "decided" ? eff.outcome.label : "unresolved"}`);
      }
    }
    // The sample exercises every outcome the policy can produce, including the default region.
    expect(seen.size).toBeGreaterThanOrEqual(7);
  });

  it("unresolved witnesses of the hidden policy are exactly its default region", async () => {
    const ws = await findUnresolved({ ...base, rules: KYC_HIDDEN_POLICY.rules, family: "reviewOutcome", limit: 10 });
    expect(ws.length).toBeGreaterThan(0);
    for (const w of ws) {
      expectValidKycCase(w);
      const oracle = KYC_HIDDEN_POLICY.evaluate(lookupOf(w.assignment)).decisions["reviewOutcome"];
      expect(oracle?.action).toBe("approve");
      const recommends = KYC_HIDDEN_POLICY.rules.filter((r) => r.effect.type === "recommend" && oracle?.firedRuleIds.includes(r.id));
      expect(recommends).toEqual([]);
    }
  });
});

describe("determinism and timing", () => {
  it("same inputs give the same witnesses (ids and assignments), regardless of earlier queries", async () => {
    const run = async () => [
      await findUnresolved({ ...base, rules: FIXTURE, family: "reviewOutcome", limit: 5 }),
      await findBoundaries({ ...base, rules: FIXTURE, ruleId: "longstanding" }),
      await findDisagreements({ ...base, rulesA: FIXTURE, rulesB: FIXTURE.slice(0, 2), experts: ["a", "b"], family: "reviewOutcome" }),
      await findConflicts({ ...base, rules: [...FIXTURE, rule("x", { "==": [v("adverseMedia"), true] }, recommend("reject"), 60)], family: "reviewOutcome" }),
    ];
    const first = await run();
    await findUnresolved({ ...base, rules: KYC_HIDDEN_POLICY.rules, family: "riskRating", limit: 7 });
    expect(await run()).toEqual(first);
  });

  it("each query finishes well under the budget on the KYC domain (~10 rules), warm", async () => {
    const oracle = KYC_HIDDEN_POLICY.rules;
    const queries: [string, () => Promise<unknown>][] = [
      ["findUnresolved(limit 5)", () => findUnresolved({ ...base, rules: oracle, family: "reviewOutcome", limit: 5 })],
      ["findConflicts(oracle)", () => findConflicts({ ...base, rules: oracle, family: "reviewOutcome" })],
      [
        "findConflicts(3 tied pairs)",
        () => findConflicts({ ...base, rules: [...oracle, rule("media", { "==": [v("adverseMedia"), true] }, recommend("reject"), 60)], family: "reviewOutcome" }),
      ],
      ["findBoundaries", () => findBoundaries({ ...base, rules: oracle, ruleId: "nsrp.highrisk.longstanding" })],
      ["findDisagreements(limit 5)", () => findDisagreements({ ...base, rulesA: oracle, rulesB: FIXTURE, experts: ["a", "b"], family: "reviewOutcome" })],
      ["practiceCases(6)", () => practiceCases({ ...base, rules: oracle, ruleIds: ["nsrp.ubo.threshold", "nsrp.funds.missing"], count: 6 })],
      ["equivalent", () => equivalent({ domain: KYC_DOMAIN, a: UBO.predicate, b: P({ ">=": [v("uboOwnershipPct"), 25] }) })],
    ];
    const report: string[] = [];
    for (const [name, query] of queries) {
      await query();
      const t0 = performance.now();
      await query();
      const ms = performance.now() - t0;
      report.push(`${name}: ${ms.toFixed(1)} ms`);
      expect(ms).toBeLessThan(5000);
    }
    console.info(`solver query timings (warm):\n  ${report.join("\n  ")}`);
  });
});
