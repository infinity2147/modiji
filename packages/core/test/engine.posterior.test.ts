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
  type CandidateRule,
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
  it("starts from a prior ∝ exp(−λ·complexity)", () => {
    const seeds = enumerateCandidates(REVIEW, [CASE_A, CASE_B], CONFIG);
    const prior = priorSet({ id: "p", model: REVIEW, seeds, schemaVersion: 1, normalizationVersion: 0, config: CONFIG });
    const c1 = prior.candidates.find((c) => c.complexity === 1);
    const c2 = prior.candidates.find((c) => c.complexity === 2);
    expect(c1 && c2 && c1.weight / c2.weight).toBeCloseTo(Math.E, 9);
  });

  it("plan §10: after cases A and B the posterior spreads over ownership-style vs jurisdiction-style hypotheses", () => {
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
    expect(ownership + jurisdiction).toBeGreaterThan(0.8);
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
    expect(low.bits).toBeLessThan(0.5);
    expect(high.bits).toBeGreaterThan(3);
    expect(isContradiction(high, CONFIG)).toBe(true);
    expect(isContradiction(low, CONFIG)).toBe(false);
    // The live step reports the pre-update surprise and returns the rebuilt set.
    const step = observeDecision({ model: REVIEW, set, knowledge: { ...EMPTY_KNOWLEDGE, observations: [CASE_A, CASE_B] }, observation: contradiction, config: CONFIG });
    expect(step.recent.surprise.bits).toBe(high.bits);
    expect(step.recent.explainedMass).toBeLessThan(0.1);
    expect(step.set.normalizationVersion).toBe(set.normalizationVersion + 1);
    expect(surprise(REVIEW, step.set, contradiction).bits).toBeLessThan(high.bits);
  });

  it("the top counterfactual on case A pits ownership against jurisdiction with EIG > 0.5 bits", () => {
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
    const assignment = top.target.assignment ?? {};
    const rivals = top.target.candidateIds.map((id) => set.candidates.find((c) => c.id === id));
    const predictions = new Map(rivals.map((c) => [c && style(c), c && predictedAction(REVIEW, c, recordLookup(assignment))]));
    expect(predictions.has("ownership") && predictions.has("jurisdiction")).toBe(true);
    expect(predictions.get("ownership")).not.toBe(predictions.get("jurisdiction"));
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
