import { describe, expect, it } from "vitest";
import { evaluatePredicate, validateFeatureValue } from "../src";
import {
  CASE_SETS,
  DEFAULT_BENCH_SIZE,
  KYC_DOMAIN,
  KycCaseSchema,
  caseFeatures,
  findKycCase,
  generateBenchCases,
  generateKycCase,
  kycCases,
  largestOwner,
  mulberry32,
  type KycCase,
  type KycFeatureTargets,
} from "../src/domains/kyc";
import { lookupFrom } from "./helpers";

const ALL: KycCase[] = CASE_SETS.flatMap((set) => kycCases(set));
const BENCH = generateBenchCases(99, 1200);

function expectValid(c: KycCase): void {
  expect(KycCaseSchema.parse(c)).toEqual(c);
  const features = caseFeatures(c);
  for (const [id, value] of Object.entries(features)) expect(validateFeatureValue(KYC_DOMAIN, id, value).ok, `${c.id} ${id}`).toBe(true);
  for (const constraint of KYC_DOMAIN.domainConstraints)
    expect(evaluatePredicate(constraint, lookupFrom(features)).truth, `${c.id} ${JSON.stringify(constraint)}`).toBe(true);
  expect(c.review.riskRating).toBe("unrated");
  expect(c.owners.reduce((s, o) => s + o.sharePct, 0)).toBeLessThanOrEqual(100);
  // Documents agree with the decision features shown elsewhere on screen.
  const sof = c.documents.find((d) => d.name === "Source-of-funds statement");
  expect(sof?.status).toBe(c.funds.sourceOfFunds === "not_provided" ? "missing" : "received");
  const passport = c.documents.find((d) => d.name === `Passport — ${largestOwner(c).name}`);
  expect(passport?.status === "received", c.id).toBe(largestOwner(c).idVerified);
}

describe("KYC case sets", () => {
  it("every case in every set (and a large bench sample) is schema-valid and satisfies the domain constraints", () => {
    for (const c of [...ALL, ...BENCH]) expectValid(c);
  });

  it("labels cases with their set, and has the documented sizes", () => {
    for (const set of CASE_SETS) for (const c of kycCases(set)) expect(c.set).toBe(set);
    expect(kycCases("training").map((c) => c.id)).toEqual(["NS-2026-0101", "NS-2026-0102", "NS-2026-0103"]);
    expect(kycCases("heldout").map((c) => c.id)).toEqual(["NS-2026-0201", "NS-2026-0202"]);
    expect(kycCases("practice")).toHaveLength(6);
    expect(kycCases("bench")).toHaveLength(DEFAULT_BENCH_SIZE);
  });

  it("uses unique NS-2026-#### ids across sets", () => {
    const ids = ALL.map((c) => c.id);
    for (const id of ids) expect(id).toMatch(/^NS-2026-\d{4}$/);
    expect(new Set(ids).size).toBe(ids.length);
    expect(new Set(BENCH.map((c) => c.id)).size).toBe(BENCH.length);
  });

  it("training cases match the demo design", () => {
    const [one, two, three] = kycCases("training").map((c) => caseFeatures(c));
    expect(one).toMatchObject({
      entityType: "company",
      jurisdictionRisk: "medium",
      uboOwnershipPct: 35,
      uboVerified: false,
      customerStatus: "new",
      sourceOfFunds: "verified",
    });
    expect(two).toMatchObject({
      entityType: "company",
      jurisdictionRisk: "high",
      customerStatus: "existing",
      accountAgeMonths: 36,
      sourceOfFunds: "verified",
      uboOwnershipPct: 20,
      uboVerified: true,
    });
    expect(three).toMatchObject({ entityType: "individual", pep: true, jurisdictionRisk: "low" });
  });

  it("held-out cases are unseen variants: a verified 30 % owner in a high-risk country, and a sanctions match", () => {
    const [a, b] = kycCases("heldout").map((c) => caseFeatures(c));
    expect(a).toMatchObject({ entityType: "company", jurisdictionRisk: "high", customerStatus: "new", uboOwnershipPct: 30, uboVerified: true, sourceOfFunds: "verified" });
    expect(b).toMatchObject({ sanctionsHit: true });
  });

  it("generated cases never reuse a surname from the hand-designed demo cases", () => {
    const demo = [...kycCases("training"), ...kycCases("heldout")];
    const surnames = new Set(demo.flatMap((c) => c.owners.map((o) => o.name.slice(o.name.indexOf(" ") + 1))));
    expect(surnames).toContain("Halvorsen");
    for (const c of [...kycCases("practice"), ...BENCH])
      for (const name of [c.customer.name, ...c.owners.map((o) => o.name)])
        for (const word of name.split(" ")) expect(surnames.has(word), `${c.id}: ${name}`).toBe(false);
  });

  it("findKycCase finds cases of every set and nothing else", () => {
    for (const c of ALL) expect(findKycCase(c.id)).toEqual(c);
    expect(findKycCase("NS-2026-9999")).toBeUndefined();
    expect(findKycCase("nope")).toBeUndefined();
  });

  it("returns fresh objects, so callers cannot corrupt a set", () => {
    const [first] = kycCases("training");
    if (first === undefined) throw new Error("no training case");
    first.customer.name = "Mutated";
    expect(kycCases("training")[0]?.customer.name).toBe("Halvorsen Marine Logistics Ltd");
  });
});

describe("KYC case generator", () => {
  it("is deterministic in the seed", () => {
    expect(generateBenchCases(42, 200)).toEqual(generateBenchCases(42, 200));
    expect(kycCases("practice")).toEqual(kycCases("practice"));
    expect(kycCases("bench")).toEqual(kycCases("bench"));
    expect(generateBenchCases(43, 50)).not.toEqual(generateBenchCases(42, 50));
  });

  it("mulberry32 has a pinned output sequence (guards cross-runtime determinism)", () => {
    const rng = mulberry32(1);
    expect(Array.from({ length: 3 }, () => rng())).toEqual([0.6270739405881613, 0.002735721180215478, 0.5274470399599522]);
  });

  it("realises the requested feature targets exactly", () => {
    const rng = mulberry32(7);
    const pick = <T,>(xs: readonly T[]): T => xs[Math.floor(rng() * xs.length)] as T;
    for (let i = 0; i < 300; i++) {
      const entityType = pick(["individual", "company", "trust"] as const);
      const customerStatus = pick(["new", "existing"] as const);
      const targets: KycFeatureTargets = {
        entityType,
        customerStatus,
        accountAgeMonths: customerStatus === "new" ? 0 : 1 + Math.floor(rng() * 200),
        jurisdictionRisk: pick(["low", "medium", "high"] as const),
        uboOwnershipPct: entityType === "individual" ? 100 : pick([1, 10, 24.5, 25, 25.5, 26, 51, 100]),
        uboVerified: rng() < 0.5,
        pep: rng() < 0.5,
        sanctionsHit: rng() < 0.5,
        adverseMedia: rng() < 0.5,
        sourceOfFunds: pick(["verified", "unverified", "not_provided"] as const),
        expectedMonthlyVolume: Math.floor(rng() * 1_000_000),
      };
      const c = generateKycCase(rng, { id: "NS-2026-0001", set: "practice", ...targets });
      expectValid(c);
      expect(caseFeatures(c)).toEqual({ ...targets, riskRating: "unrated" });
    }
  });

  it("rejects contradictory targets", () => {
    const rng = mulberry32(1);
    expect(() => generateKycCase(rng, { id: "NS-2026-0001", set: "practice", entityType: "individual", uboOwnershipPct: 40 })).toThrow(
      /individual owns 100%/,
    );
    expect(() => generateKycCase(rng, { id: "NS-2026-0001", set: "practice", customerStatus: "new", accountAgeMonths: 5 })).toThrow(
      /0 exactly for new customers/,
    );
    expect(() => generateKycCase(rng, { id: "NS-2026-0001", set: "practice", customerStatus: "existing", accountAgeMonths: 0 })).toThrow(
      /0 exactly for new customers/,
    );
    expect(() => generateBenchCases(1, 6001)).toThrow(RangeError);
  });
});
