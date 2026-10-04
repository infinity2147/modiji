import { describe, expect, it } from "vitest";
import {
  EMPTY_KNOWLEDGE,
  HypothesisSetSchema,
  actionLikelihood,
  buildHypothesisSet,
  describePredicate,
  enumerateCandidates,
  evaluatePredicate,
  featuresReferenced,
  generateQuestions,
  isContradiction,
  likelihoodMatrix,
  observeDecision,
  predictedAction,
  priorSet,
  recordLookup,
  selectQuestion,
  surprise,
  unknown,
  updatePosterior,
  engineConfig,
  priorGroupKey,
  type CandidateRule,
  type EngineConfig,
  type Question,
  type HypothesisSet,
} from "../src";
import { CASE_A, CASE_B, CONFIG, KYC, REVIEW, observation, questionContext } from "./engine.fixtures";

const build = (observations = [CASE_A, CASE_B]): HypothesisSet =>
  buildHypothesisSet({ setId: "hs-review", model: REVIEW, knowledge: { ...EMPTY_KNOWLEDGE, observations }, schemaVersion: 1, config: CONFIG });

const style = (c: CandidateRule): "ownership" | "jurisdiction" | "other" => {
  const fs = featuresReferenced(c.predicate);
  if (fs.every((f) => f === "uboOwnershipPct" || f === "uboVerified")) return "ownership";
  if (fs.every((f) => f === "jurisdictionRisk")) return "jurisdiction";
  return "other";
};
const mass = (set: HypothesisSet, s: ReturnType<typeof style>): number => set.candidates.filter((c) => style(c) === s).reduce((m, c) => m + c.weight, 0);

describe("likelihood", () => {
  it("is 1−ε for the predicted action and ε/(|A|−1) otherwise; every row sums to 1", () => {
    expect(actionLikelihood(REVIEW, "approve" as never, "approve" as never)).toBe(0.95);
    expect(actionLikelihood(REVIEW, "approve" as never, "reject" as never)).toBeCloseTo(0.05 / 4, 15);
    const set = build();
    for (const row of likelihoodMatrix(REVIEW, set.candidates, recordLookup(CASE_A.features)))
      expect(row.reduce((s, x) => s + x, 0)).toBeCloseTo(1, 12);
  });

  it("predicts 'if p then a else default'", () => {
    const h = { predicate: { ">": [{ var: "uboOwnershipPct" }, 25] }, predictedAction: "enhancedReview" } as unknown as CandidateRule;
    expect(predictedAction(REVIEW, h, recordLookup(CASE_A.features))).toBe("enhancedReview");
    expect(predictedAction(REVIEW, h, recordLookup(CASE_B.features))).toBe("approve");
    expect(predictedAction(REVIEW, h, recordLookup({}))).toBe("unknown");
  });
});

describe("posterior", () => {
  const prior = (config: EngineConfig, observations = [CASE_A, CASE_B]) =>
    priorSet({ id: "p", model: REVIEW, seeds: enumerateCandidates(REVIEW, observations, config), schemaVersion: 1, normalizationVersion: 0, config });
  const groupMass = (set: HypothesisSet, key: string) => set.candidates.filter((c) => priorGroupKey(c) === key).reduce((s, c) => s + c.weight, 0);
  const weightOf = (set: HypothesisSet, predicate: unknown, action: string) =>
    set.candidates.find((c) => c.predictedAction === action && JSON.stringify(c.predicate) === JSON.stringify(predicate))?.weight ?? Number.NaN;
  const MEDIUM = { "==": [{ var: "jurisdictionRisk" }, "medium"] };

  it("per_hypothesis: every candidate's prior ∝ exp(−λ·complexity)", () => {
    const p = prior(engineConfig({ priorGrouping: "per_hypothesis" }));
    const c1 = p.candidates.find((c) => c.complexity === 1);
    const c2 = p.candidates.find((c) => c.complexity === 2);
    expect(c1 && c2 && c1.weight / c2.weight).toBeCloseTo(Math.E, 9);
  });

  it("per_feature_direction (default): threshold variants share one exp(−λ·complexity) unit, so their count does not matter", () => {
    expect(CONFIG.priorGrouping).toBe("per_feature_direction");
    const up = priorGroupKey({ predicate: { ">": [{ var: "uboOwnershipPct" }, 25] } as never, predictedAction: "enhancedReview" as never });
    expect(priorGroupKey({ predicate: { ">=": [{ var: "uboOwnershipPct" }, 27.5] } as never, predictedAction: "enhancedReview" as never })).toBe(up);
    expect(priorGroupKey({ predicate: { "<": [25, { var: "uboOwnershipPct" }] } as never, predictedAction: "enhancedReview" as never })).toBe(up);
    expect(priorGroupKey({ predicate: { "<": [{ var: "uboOwnershipPct" }, 25] } as never, predictedAction: "enhancedReview" as never })).not.toBe(up);
    expect(priorGroupKey({ predicate: { ">": [{ var: "uboOwnershipPct" }, 25] } as never, predictedAction: "reject" as never })).not.toBe(up);
    for (const roundThresholdsPerBoundary of [0, 1, 3, 6]) {
      const p = prior(engineConfig({ roundThresholdsPerBoundary }));
      // A whole threshold group weighs what one equality condition of the same complexity weighs …
      const unit = Math.exp(-(roundThresholdsPerBoundary === 0 ? 2 : 1)); // midpoint-only groups have complexity 2
      expect(groupMass(p, up) / weightOf(p, MEDIUM, "enhancedReview")).toBeCloseTo(unit / Math.exp(-1), 9);
      // … and inside it a round threshold keeps its exp(−λ) edge over the midpoint.
      if (roundThresholdsPerBoundary > 0) {
        const round = weightOf(p, { ">": [{ var: "uboOwnershipPct" }, 25] }, "enhancedReview");
        expect(round / weightOf(p, { ">": [{ var: "uboOwnershipPct" }, 27.5] }, "enhancedReview")).toBeCloseTo(Math.E, 9);
      }
    }
    // Conjunctions group by their sorted (feature, direction) tuple.
    const and = (a: unknown, b: unknown) => ({ predicate: { and: [a, b] } as never, predictedAction: "enhancedReview" as never });
    expect(priorGroupKey(and({ ">": [{ var: "uboOwnershipPct" }, 25] }, MEDIUM))).toBe(priorGroupKey(and(MEDIUM, { ">=": [{ var: "uboOwnershipPct" }, 30] })));
  });

  it("plan §10: after cases A and B the posterior spreads over ownership-style vs jurisdiction-style hypotheses", () => {
    const perHypothesis = buildHypothesisSet({
      setId: "hs-review",
      model: REVIEW,
      knowledge: { ...EMPTY_KNOWLEDGE, observations: [CASE_A, CASE_B] },
      schemaVersion: 1,
      config: engineConfig({ priorGrouping: "per_hypothesis" }),
    });
    console.info(`[§10 per_hypothesis] ownership-style mass=${mass(perHypothesis, "ownership").toFixed(3)} jurisdiction-style mass=${mass(perHypothesis, "jurisdiction").toFixed(3)}`);
    expect(mass(perHypothesis, "ownership")).toBeGreaterThan(mass(perHypothesis, "jurisdiction"));
    const set = build();
    expect(HypothesisSetSchema.safeParse(set).success).toBe(true);
    expect(set.normalizationVersion).toBe(1);
    const ownership = mass(set, "ownership");
    const jurisdiction = mass(set, "jurisdiction");
    const top = [...set.candidates].sort((a, b) => b.weight - a.weight).slice(0, 10);
    console.info(
      `[§10] candidates=${set.candidates.length} ownership-style mass=${ownership.toFixed(3)} jurisdiction-style mass=${jurisdiction.toFixed(3)}\n` +
        top.map((c) => `  ${c.weight.toFixed(4)}  if ${describePredicate(c.predicate, KYC)} then ${c.predictedAction}`).join("\n"),
    );
    expect(ownership).toBeGreaterThan(0.3);
    expect(jurisdiction).toBeGreaterThan(0.15);
    expect(ownership + jurisdiction).toBeGreaterThan(0.6);
    // Every heavy candidate explains both decisions.
    for (const c of top) {
      expect(predictedAction(REVIEW, c, recordLookup(CASE_A.features))).toBe("enhancedReview");
      expect(predictedAction(REVIEW, c, recordLookup(CASE_B.features))).toBe("approve");
    }
  });

  it("a contradiction raises surprise (computed before the update)", () => {
    const set = build();
    const consistent = observation("C1", { ...CASE_A.features, uboOwnershipPct: 40 }, "enhancedReview");
    const contradiction = observation("C2", { ...CASE_A.features, uboOwnershipPct: 40 }, "approve");
    const low = surprise(REVIEW, set, consistent);
    const high = surprise(REVIEW, set, contradiction);
    console.info(`[§10] surprise: consistent=${low.bits.toFixed(3)} bits, contradiction=${high.bits.toFixed(3)} bits`);
    expect(low.bits).toBeLessThan(1);
    // Extra decision features leave more rival explanations after two observations.
    // The conflicting decision must still be at least twice as surprising in probability.
    expect(high.bits - low.bits).toBeGreaterThan(1);
    expect(isContradiction(high, engineConfig({ contradictionBits: high.bits }))).toBe(true);
    expect(isContradiction(low, CONFIG)).toBe(false);
    // The live step reports the pre-update surprise and returns the rebuilt set.
    const step = observeDecision({ model: REVIEW, set, knowledge: { ...EMPTY_KNOWLEDGE, observations: [CASE_A, CASE_B] }, observation: contradiction, config: CONFIG });
    expect(step.recent.surprise.bits).toBe(high.bits);
    expect(step.recent.explainedMass).toBeLessThan(CONFIG.explainedMass);
    expect(step.set.normalizationVersion).toBe(set.normalizationVersion + 1);
    expect(surprise(REVIEW, step.set, contradiction).bits).toBeLessThan(high.bits);
  });

  it("counterfactuals on case A: the top one splits the explanations (EIG > 0.5 bits); moving country risk pits ownership against jurisdiction", () => {
    const set = build();
    const queue = generateQuestions({ model: REVIEW, set, ctx: questionContext(CASE_A, [CASE_A.id]), config: CONFIG });
    const top = selectQuestion(queue, { thetaAsk: 0.5 });
    if (top === undefined) throw new Error("no question above θ_ask");
    console.info(
      `[§10] top question (EIG ${top.value.toFixed(3)} bits): "${top.text}"\n` +
        queue
          .slice(0, 5)
          .map((q) => `  ${q.value.toFixed(3)}  ${q.text}`)
          .join("\n"),
    );
    expect(top.kind).toBe("counterfactual");
    expect(top.value).toBeGreaterThan(0.5);
    const predictionsOf = (q: Question) =>
      q.target.candidateIds.map((id) => {
        const c = set.candidates.find((x) => x.id === id);
        if (c === undefined) throw new Error(`rival ${id} not in set`);
        return { style: style(c), action: predictedAction(REVIEW, c, recordLookup(q.target.assignment ?? {})) };
      });
    expect(new Set(predictionsOf(top).map((p) => p.action)).size).toBeGreaterThan(1);
    const high = queue.find((q) => q.target.feature === "jurisdictionRisk" && q.target.assignment?.["jurisdictionRisk" as never] === "high");
    if (high === undefined) throw new Error("no country-risk counterfactual");
    console.info(`[§10] "${high.text}" EIG ${high.value.toFixed(3)} bits`);
    expect(high.value).toBeGreaterThan(0.5);
    const rivals = new Map(predictionsOf(high).map((p) => [p.style, p.action]));
    expect(rivals.get("ownership")).toBe("enhancedReview");
    expect(rivals.get("jurisdiction")).toBe("approve");
  });

  it("a candidate that cannot evaluate an observation is not updated by it (unknown → marginal)", () => {
    const set = build();
    const partial = observation("U", { ...CASE_A.features, jurisdictionRisk: unknown("not_visible") }, "approve");
    const lookup = recordLookup(partial.features);
    const isUnknownOn = (c: CandidateRule): boolean => evaluatePredicate(c.predicate, lookup).truth === "unknown";
    const before = set.candidates.filter(isUnknownOn).reduce((s, c) => s + c.weight, 0);
    const after = updatePosterior(REVIEW, set, partial);
    expect(before).toBeGreaterThan(0.1);
    expect(after.candidates.filter(isUnknownOn).reduce((s, c) => s + c.weight, 0)).toBeCloseTo(before, 12);
    expect(HypothesisSetSchema.safeParse(after).success).toBe(true);
    // An observation nobody can evaluate changes nothing.
    const blank = updatePosterior(REVIEW, set, observation("V", {}, "reject"));
    blank.candidates.forEach((c, i) => expect(c.weight).toBeCloseTo(set.candidates[i]?.weight ?? -1, 12));
  });

  it("an empty set predicts uniformly", () => {
    const empty = { ...build(), candidates: [] };
    expect(surprise(REVIEW, empty, CASE_A).bits).toBeCloseTo(Math.log2(5), 12);
  });
});
