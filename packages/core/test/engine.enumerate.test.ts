import { describe, expect, it } from "vitest";
import {
  engineConfig,
  enumerateCandidates,
  evaluatePredicate,
  familyModel,
  featuresReferenced,
  isMeaningfulRound,
  loadDomainConfig,
  meaningfulRoundsIn,
  predicateNode,
  roundestBetween,
  typecheckPredicate,
  type CandidateSeed,
  type FeatureId,
  type Predicate,
} from "../src";
import { CASE_A, CASE_B, CONFIG, KYC, REVIEW, observation } from "./engine.fixtures";
import { lookupFrom } from "./helpers";

const DOMAIN = loadDomainConfig({
  id: "toy",
  title: "Toy",
  features: [
    { id: "pct", label: "Share", source: "case", type: "number", min: 0, max: 100, unit: "%" },
    { id: "months", label: "Age", source: "case", type: "number", min: 0, max: 600, integer: true, unit: "months" },
    { id: "eur", label: "Volume", source: "case", type: "number", min: 0, max: 1_000_000, integer: true, unit: "EUR" },
    { id: "a", label: "A", source: "case", type: "boolean" },
    { id: "b", label: "B", source: "case", type: "boolean" },
    { id: "c", label: "C", source: "case", type: "boolean" },
    { id: "tier", label: "Tier", source: "case", type: "enum", values: ["low", "mid", "high"] },
    { id: "kind", label: "Kind", source: "case", type: "enum", values: ["new", "old"] },
  ],
  actions: [
    { id: "ok", label: "OK", terminal: true },
    { id: "review", label: "Review", terminal: true },
    { id: "reject", label: "Reject", terminal: true },
  ],
  decisionFamilies: [{ id: "fam", label: "Family", actions: ["ok", "review", "reject"] }],
  domainConstraints: [],
  criticalFields: [],
});
const MODEL = familyModel(DOMAIN, "fam", CONFIG);
const BASE = { pct: 50, months: 12, eur: 1000, a: false, b: false, c: false, tier: "low", kind: "new" };

/** Numeric thresholds the candidates use on `feature`. */
function thresholds(seeds: readonly CandidateSeed[], feature: string): number[] {
  const out = new Set<number>();
  const visit = (p: Predicate): void => {
    const node = predicateNode(p);
    if (node.key === "and" || node.key === "or" || node.key === "!") return node.args.forEach(visit);
    if (node.key === "in") return;
    const [l, r] = node.args;
    if (typeof l === "object" && l !== null && "var" in l && l.var === feature && typeof r === "number") out.add(r);
  };
  seeds.forEach((s) => visit(s.predicate));
  return [...out].sort((x, y) => x - y);
}

const conditions = (p: Predicate): number => {
  const node = predicateNode(p);
  return node.key === "and" || node.key === "or" ? node.args.reduce((s, c) => s + conditions(c), 0) : 1;
};

describe("enumerateCandidates", () => {
  it("puts thresholds at the midpoint between differing observations, plus round numbers inside that boundary", () => {
    const seeds = enumerateCandidates(MODEL, [observation("o1", { ...BASE, pct: 12 }, "ok"), observation("o2", { ...BASE, pct: 43 }, "review")], CONFIG);
    // Midpoint 27.5; the 3 roundest values in [12, 43]: 25 (multiple of 25), then 30 and 20 (multiples of 10, closest to the midpoint).
    expect(thresholds(seeds, "pct")).toEqual([20, 25, 27.5, 30]);
    expect(seeds.some((s) => JSON.stringify(s.predicate) === JSON.stringify({ ">": [{ var: "pct" }, 27.5] }))).toBe(true);
  });

  it("puts no threshold between adjacent values with the same action, and none outside the boundary", () => {
    const seeds = enumerateCandidates(
      MODEL,
      [observation("o1", { ...BASE, pct: 12 }, "ok"), observation("o2", { ...BASE, pct: 15 }, "ok"), observation("o3", { ...BASE, pct: 60 }, "review")],
      CONFIG,
    );
    expect(thresholds(seeds, "pct").every((t) => t >= 15 && t <= 60)).toBe(true);
    expect(thresholds(seeds, "pct")).toContain(37.5);
  });

  it("uses domain-meaningful round numbers: multiples of 12 for months, 1-2-5 values for money, all within bounds", () => {
    const seeds = enumerateCandidates(
      MODEL,
      [observation("o1", { ...BASE, months: 0, eur: 1_000 }, "ok"), observation("o2", { ...BASE, months: 36, eur: 700_000 }, "review")],
      CONFIG,
    );
    const months = thresholds(seeds, "months");
    expect(months).toEqual([0, 12, 18, 24]);
    expect(months.every(Number.isInteger)).toBe(true);
    // Money: 1-2-5 round values in [1 000, 700 000] (500k, then 400k and 200k), plus the midpoint.
    expect(thresholds(seeds, "eur")).toEqual([200_000, 350_500, 400_000, 500_000]);
  });

  it("drops conditions that are constant on the feature's range and deduplicates by accepted values", () => {
    const seeds = enumerateCandidates(
      MODEL,
      [observation("o1", { ...BASE, months: 0 }, "ok"), observation("o2", { ...BASE, months: 36 }, "review")],
      CONFIG,
    );
    const months = seeds.filter((s) => featuresReferenced(s.predicate).join() === "months");
    // ">= 0" is always true and "< 0" never: neither may appear.
    for (const s of months) {
      const truths = Array.from({ length: 601 }, (_, m) => evaluatePredicate(s.predicate, lookupFrom({ months: m })).truth);
      expect(truths.includes(true) && truths.includes(false)).toBe(true);
    }
    // No two single-condition candidates with the same action accept the same integers.
    const signatures = months.map((s) => `${s.predictedAction}:${Array.from({ length: 601 }, (_, m) => (evaluatePredicate(s.predicate, lookupFrom({ months: m })).truth ? 1 : 0)).join("")}`);
    expect(new Set(signatures).size).toBe(signatures.length);
    // Two-valued enums get == only (!= new is == old).
    expect(seeds.some((s) => "!=" in s.predicate && featuresReferenced(s.predicate).join() === "kind")).toBe(false);
  });

  it("builds conjunctions only when every conjunct narrows coverage, and respects the 2/3 condition limit", () => {
    const obs = [
      observation("p", { ...BASE, a: true, b: true, c: true }, "review"),
      observation("n1", { ...BASE, a: false, b: true, c: true }, "ok"),
      observation("n2", { ...BASE, a: true, b: false, c: true }, "ok"),
      observation("n3", { ...BASE, a: true, b: true, c: false }, "ok"),
    ];
    const two = enumerateCandidates(MODEL, obs, CONFIG);
    const three = enumerateCandidates(MODEL, obs, engineConfig({ maxConditions: 3 }));
    expect(Math.max(...two.map((s) => conditions(s.predicate)))).toBe(2);
    expect(Math.max(...three.map((s) => conditions(s.predicate)))).toBe(3);
    const abc = { and: [{ "==": [{ var: "a" }, true] }, { "==": [{ var: "b" }, true] }, { "==": [{ var: "c" }, true] }] };
    expect(three.some((s) => JSON.stringify(s.predicate) === JSON.stringify(abc) && s.predictedAction === "review")).toBe(true);
    // Conjunctions predict only observed non-default actions and never combine two conditions on one feature.
    for (const s of three.filter((x) => conditions(x.predicate) > 1)) {
      expect(s.predictedAction).toBe("review");
      expect(featuresReferenced(s.predicate)).toHaveLength(conditions(s.predicate));
    }
    // With only the scenario's two cases, no conjunction earns its place.
    expect(enumerateCandidates(REVIEW, [CASE_A, CASE_B], CONFIG).every((s) => conditions(s.predicate) === 1)).toBe(true);
  });

  it("every candidate type-checks, never predicts the default action, and has a unique id", () => {
    for (const [model, domain, obs] of [
      [REVIEW, KYC, [CASE_A, CASE_B]],
      [MODEL, DOMAIN, [observation("o1", { ...BASE, pct: 12, a: true }, "ok"), observation("o2", { ...BASE, pct: 43 }, "reject")]],
    ] as const) {
      const seeds = enumerateCandidates(model, obs, engineConfig({ maxConditions: 3 }));
      expect(seeds.length).toBeGreaterThan(0);
      for (const s of seeds) {
        expect(typecheckPredicate(s.predicate, domain.features)).toEqual([]);
        expect(s.predictedAction).not.toBe(model.defaultAction);
        expect(s.origin).toBe("enumerated");
      }
      expect(new Set(seeds.map((s) => s.id)).size).toBe(seeds.length);
    }
  });

  it("is deterministic, independent of observation order, and bounded by maxCandidates (simplest first)", () => {
    const obs = [CASE_A, CASE_B, observation("C", { ...CASE_A.features, uboOwnershipPct: 60, pep: true }, "escalateCompliance")];
    const one = enumerateCandidates(REVIEW, obs, CONFIG);
    expect(enumerateCandidates(REVIEW, obs, CONFIG)).toEqual(one);
    expect(new Set(enumerateCandidates(REVIEW, [...obs].reverse(), CONFIG).map((s) => s.id))).toEqual(new Set(one.map((s) => s.id)));
    const bounded = enumerateCandidates(REVIEW, obs, engineConfig({ maxCandidates: 25 }));
    expect(bounded).toHaveLength(25);
    expect(Math.max(...bounded.map((s) => s.complexity))).toBeLessThanOrEqual(Math.min(...one.slice(25).map((s) => s.complexity)));
  });
});

describe("round numbers", () => {
  const pct = KYC.features.find((f) => f.id === "uboOwnershipPct");
  it("ranks % thresholds by roundness and stays inside the feature bounds", () => {
    if (pct?.type !== "number") throw new Error("fixture");
    expect(meaningfulRoundsIn(pct, 20, 35, 3)).toEqual([25, 30, 20]);
    expect(meaningfulRoundsIn(pct, 95, 140, 5)).toEqual([100, 95]);
    expect(isMeaningfulRound(pct, 27.5)).toBe(false);
    expect(roundestBetween(pct, 25, 27.5)).toBe(26);
    expect(roundestBetween(pct, 20, 35)).toBe(25);
  });
  it("never proposes a non-integer value for an integer feature", () => {
    const age = KYC.features.find((f) => f.id === ("accountAgeMonths" as FeatureId));
    if (age?.type !== "number") throw new Error("fixture");
    expect(roundestBetween(age, 3, 4)).toBeUndefined();
    expect(roundestBetween(age, 0, 36)).toBe(12);
  });
});
