import fc from "fast-check";
import { describe, expect, it } from "vitest";
import {
  EMPTY_KNOWLEDGE,
  buildHypothesisSet,
  counterfactualEig,
  entropy,
  informationGain,
  mutualInformation,
  predictedAction,
  recordLookup,
  type HypothesisSet,
} from "../src";
import { CASE_A, CASE_B, CONFIG, REVIEW } from "./engine.fixtures";

const RUNS = { seed: 20261004, numRuns: 400 };

const normalize = (xs: readonly number[]): number[] => {
  const total = xs.reduce((s, x) => s + x, 0);
  return xs.map((x) => x / total);
};
/** Positive weights for n hypotheses and a likelihood row (a distribution over k answers) per hypothesis. */
const problem = fc.integer({ min: 2, max: 5 }).chain((k) =>
  fc.integer({ min: 1, max: 12 }).chain((n) =>
    fc.record({
      k: fc.constant(k),
      weights: fc.array(fc.double({ min: 0.001, max: 1, noNaN: true }), { minLength: n, maxLength: n }).map(normalize),
      rows: fc.array(fc.array(fc.double({ min: 0, max: 1, noNaN: true }), { minLength: k, maxLength: k }).map((r) => normalize(r.map((x) => x + 1e-6))), {
        minLength: n,
        maxLength: n,
      }),
    }),
  ),
);

describe("expected information gain", () => {
  it("mutual information H(A) − Σ w·H(A|h) equals H(W) − Σ P(a)·H(W|a) to 1e-9", () => {
    fc.assert(
      fc.property(problem, ({ weights, rows }) => {
        expect(Math.abs(mutualInformation(weights, rows) - informationGain(weights, rows))).toBeLessThan(1e-9);
      }),
      RUNS,
    );
  });

  it("is 0 when all hypotheses agree, and never exceeds log2|A|", () => {
    fc.assert(
      fc.property(problem, ({ k, weights, rows }) => {
        const first = rows[0] ?? [];
        expect(mutualInformation(weights, rows.map(() => first))).toBeCloseTo(0, 12);
        const eig = mutualInformation(weights, rows);
        expect(eig).toBeGreaterThanOrEqual(0);
        expect(eig).toBeLessThanOrEqual(Math.log2(k) + 1e-12);
        expect(eig).toBeLessThanOrEqual(entropy(weights) + 1e-12);
      }),
      RUNS,
    );
  });

  it("reaches 1 bit for two equally likely noiseless hypotheses that disagree", () => {
    expect(mutualInformation([0.5, 0.5], [[1, 0], [0, 1]])).toBeCloseTo(1, 12);
    expect(informationGain([0.5, 0.5], [[1, 0], [0, 1]])).toBeCloseTo(1, 12);
  });

  it("on the hypothesis set: 0 where every candidate agrees, positive where they split", () => {
    const set: HypothesisSet = buildHypothesisSet({ setId: "hs", model: REVIEW, knowledge: { ...EMPTY_KNOWLEDGE, observations: [CASE_A, CASE_B] }, schemaVersion: 1, config: CONFIG });
    const lookup = recordLookup(CASE_A.features);
    const agree = set.candidates.filter((c) => predictedAction(REVIEW, c, lookup) === "enhancedReview");
    const total = agree.reduce((s, c) => s + c.weight, 0);
    const agreeing = { ...set, candidates: agree.map((c) => ({ ...c, weight: c.weight / total })) };
    expect(counterfactualEig(REVIEW, agreeing, lookup)).toBeCloseTo(0, 12);
    expect(counterfactualEig(REVIEW, set, recordLookup({ ...CASE_A.features, jurisdictionRisk: "high" }))).toBeGreaterThan(0.5);
  });
});
