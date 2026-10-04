import fc from "fast-check";
import { describe, expect, it } from "vitest";
import {
  EMPTY_KNOWLEDGE,
  MAX_QUESTION_WORDS,
  QUESTION_REASONS,
  QuestionSchema,
  buildHypothesisSet,
  describeQuestion,
  engineConfig,
  evaluatePredicate,
  generateQuestions,
  isUnknown,
  observeDecision,
  recordLookup,
  screenAnswers,
  selectQuestion,
  unknown,
  wordCount,
  type FeatureValue,
  type HypothesisSet,
  type ProposedConcept,
  type Question,
} from "../src";
import { KYC_HIDDEN_POLICY } from "../src/domains/kyc/domain.oracle.server";
import { caseFeatures, kycCases } from "../src/domains/kyc";
import { lookupFrom } from "./helpers";
import { CASE_A, CASE_B, CONFIG, KYC, REVIEW, observation, questionContext } from "./engine.fixtures";

const RUNS = { seed: 20261004, numRuns: 60 };

/** A third training-like case so thresholds exist on relationship age and more ownership values. */
const CASE_C = observation(
  "C",
  { ...CASE_A.features, customerStatus: "new", accountAgeMonths: 0, uboOwnershipPct: 60, jurisdictionRisk: "low", uboVerified: true },
  "requestDocuments",
);
const SET: HypothesisSet = buildHypothesisSet({
  setId: "hs-review",
  model: REVIEW,
  knowledge: { ...EMPTY_KNOWLEDGE, observations: [CASE_A, CASE_B, CASE_C] },
  schemaVersion: 1,
  config: CONFIG,
});

const kycCase = fc
  .record({
    entityType: fc.constantFrom("individual", "company", "trust"),
    customerStatus: fc.constantFrom("new", "existing"),
    accountAgeMonths: fc.integer({ min: 1, max: 600 }),
    jurisdictionRisk: fc.constantFrom("low", "medium", "high"),
    uboOwnershipPct: fc.integer({ min: 0, max: 200 }).map((x) => x / 2),
    uboVerified: fc.boolean(),
    pep: fc.boolean(),
    sanctionsHit: fc.boolean(),
    adverseMedia: fc.boolean(),
    sourceOfFunds: fc.constantFrom("verified", "unverified", "not_provided"),
    expectedMonthlyVolume: fc.integer({ min: 0, max: 10_000_000 }),
    riskRating: fc.constantFrom("unrated", "low", "medium", "high"),
  })
  .map((c): Record<string, FeatureValue> => ({
    ...c,
    uboOwnershipPct: c.entityType === "individual" ? 100 : c.uboOwnershipPct,
    accountAgeMonths: c.customerStatus === "new" ? 0 : c.accountAgeMonths,
  }));

const satisfiesConstraints = (assignment: Record<string, FeatureValue>): boolean =>
  KYC.domainConstraints.every((c) => evaluatePredicate(c, recordLookup(assignment)).truth === true);

const counterfactualOn = (queue: readonly Question[], feature: string, value: FeatureValue): Question | undefined =>
  queue.find((q) => q.kind === "counterfactual" && q.target.feature === feature && q.target.assignment?.[feature as never] === value);

describe("counterfactual questions", () => {
  it("always satisfy the domain constraints, move the target feature, adjust at most one other, and fit 25 words", () => {
    fc.assert(
      fc.property(kycCase, (features) => {
        const base = observation("X", features, "approve");
        const queue = generateQuestions({ model: REVIEW, set: SET, ctx: questionContext(base), config: CONFIG });
        for (const q of queue) {
          expect(QuestionSchema.safeParse(q).success).toBe(true);
          expect(wordCount(q.text)).toBeLessThanOrEqual(MAX_QUESTION_WORDS);
          if (q.kind !== "counterfactual") continue;
          const assignment = q.target.assignment ?? {};
          expect(satisfiesConstraints(assignment)).toBe(true);
          const changed = Object.keys(features).filter((k) => assignment[k as never] !== features[k]);
          expect(changed).toContain(q.target.feature);
          expect(changed.length).toBeLessThanOrEqual(2);
        }
      }),
      RUNS,
    );
  });

  it("adjusts a forced feature minimally and says so: existing → new means 0 months; company → individual means 100%", () => {
    const queue = generateQuestions({ model: REVIEW, set: SET, ctx: questionContext(CASE_A), config: CONFIG });
    const toNew = counterfactualOn(queue, "customerStatus", "new");
    expect(toNew?.target.assignment?.["accountAgeMonths" as never]).toBe(0);
    expect(toNew?.text).toBe("If customer status were new instead of existing (relationship age 0 months), what would you decide?");
    const toIndividual = counterfactualOn(queue, "entityType", "individual");
    expect(toIndividual?.target.assignment?.["uboOwnershipPct" as never]).toBe(100);
    // Moving the ownership share of an individual is repaired by changing the entity type, never left invalid.
    const individual = observation("I", { ...CASE_B.features, entityType: "individual", uboOwnershipPct: 100 }, "approve");
    for (const q of generateQuestions({ model: REVIEW, set: SET, ctx: questionContext(individual), config: CONFIG }))
      if (q.kind === "counterfactual" && q.target.feature === "uboOwnershipPct") expect(q.target.assignment?.["entityType" as never]).not.toBe("individual");
  });

  it("are not asked about a case whose validity cannot be established (unknown constraint inputs)", () => {
    const partial = observation("P", { ...CASE_A.features, customerStatus: unknown("not_visible") }, "approve");
    const queue = generateQuestions({ model: REVIEW, set: SET, ctx: questionContext(partial), config: CONFIG });
    expect(queue.filter((q) => q.kind === "counterfactual")).toEqual([]);
  });
});

describe("never ask what the screen answers", () => {
  const concept = (name: string, label: string): ProposedConcept => ({ name, label, definition: `${label} as the expert uses it`, type: "boolean" });
  const concepts = [concept("uboVerified", "owner verified"), concept("supplierRelationshipAge", "relationship with the supplier")];

  it("drops a probe whose target feature is known on screen, keeps it when it is not", () => {
    const known = generateQuestions({ model: REVIEW, set: SET, ctx: questionContext(CASE_A), concepts, config: CONFIG });
    expect(known.some((q) => q.target.feature === "uboVerified" && q.kind !== "counterfactual")).toBe(false);
    expect(known.some((q) => q.kind === "concept_definition" && q.target.feature === "supplierRelationshipAge")).toBe(true);
    const hidden = observation("H", { ...CASE_A.features, uboVerified: unknown("not_extracted") }, "approve");
    const asked = generateQuestions({ model: REVIEW, set: SET, ctx: questionContext(hidden), concepts, config: CONFIG });
    expect(asked.some((q) => q.kind === "concept_definition" && q.target.feature === "uboVerified")).toBe(true);
  });

  it("holds for every generated case and question (property)", () => {
    fc.assert(
      fc.property(kycCase, fc.subarray(KYC.features.map((f) => f.id)), (features, hidden) => {
        const shown = { ...features, ...Object.fromEntries(hidden.map((id) => [id, unknown("not_visible")])) };
        const ctx = questionContext(observation("X", shown, "approve"));
        const probes = KYC.features.map((f) => concept(f.id, f.label));
        for (const q of generateQuestions({ model: REVIEW, set: SET, ctx, concepts: probes, config: CONFIG })) {
          expect(screenAnswers(q, KYC, ctx.context)).toBe(false);
          if (q.kind === "concept_definition" && q.target.feature !== undefined) {
            const value = shown[q.target.feature];
            expect(value === undefined || isUnknown(value)).toBe(true);
          }
        }
      }),
      { ...RUNS, numRuns: 40 },
    );
  });
});

describe("why-probes, reasons and selection", () => {
  it("asks an ACTA why-probe for a decision the hypotheses could not explain", () => {
    const empty = buildHypothesisSet({ setId: "hs-review", model: REVIEW, knowledge: EMPTY_KNOWLEDGE, schemaVersion: 1, config: CONFIG });
    const first = observeDecision({ model: REVIEW, set: empty, knowledge: EMPTY_KNOWLEDGE, observation: CASE_A, config: CONFIG });
    const queue = generateQuestions({ model: REVIEW, set: first.set, ctx: questionContext(CASE_A, [CASE_A.id]), recent: first.recent, config: CONFIG });
    const why = queue.find((q) => q.kind === "why_probe");
    expect(why?.text).toBe("What told you to send to enhanced review here? What would have changed your mind?");
    expect(why?.reason).toBe(QUESTION_REASONS.unexplained);
    expect(why?.ephemeral).toBe(true);
    expect(why?.value).toBeCloseTo(first.recent.surprise.bits, 12);
    // Once the hypotheses predicted the decision, no why-probe.
    const second = observeDecision({ model: REVIEW, set: first.set, knowledge: first.knowledge, observation: CASE_B, config: CONFIG });
    const third = observeDecision({ model: REVIEW, set: second.set, knowledge: second.knowledge, observation: observation("A2", { ...CASE_A.features, uboOwnershipPct: 40 }, "enhancedReview"), config: CONFIG });
    expect(generateQuestions({ model: REVIEW, set: third.set, ctx: questionContext(CASE_A), recent: third.recent, config: CONFIG }).some((q) => q.kind === "why_probe")).toBe(false);
  });

  it("labels counterfactuals after a contradiction, and selects the best question at or above θ_ask", () => {
    const knowledge = { ...EMPTY_KNOWLEDGE, observations: [CASE_A, CASE_B] };
    const set = buildHypothesisSet({ setId: "hs-review", model: REVIEW, knowledge, schemaVersion: 1, config: CONFIG });
    const step = observeDecision({ model: REVIEW, set, knowledge, observation: observation("D", { ...CASE_A.features, uboOwnershipPct: 40 }, "approve"), config: CONFIG });
    const queue = generateQuestions({ model: REVIEW, set: step.set, ctx: questionContext(CASE_A), recent: step.recent, config: CONFIG });
    // The label follows `contradictionBits`: at or above it "contradiction detected", below it "competing explanations".
    const bits = step.recent.surprise.bits;
    const labelled = (contradictionBits: number) =>
      generateQuestions({ model: REVIEW, set: step.set, ctx: questionContext(CASE_A), recent: step.recent, config: engineConfig({ contradictionBits }) })
        .filter((q) => q.kind === "counterfactual")
        .map((q) => q.reason);
    expect(new Set(labelled(bits))).toEqual(new Set([QUESTION_REASONS.contradiction]));
    expect(new Set(labelled(bits + 0.01))).toEqual(new Set([QUESTION_REASONS.competing]));
    const best = selectQuestion(queue, { thetaAsk: 0 });
    expect(best).toBe(queue[0]);
    expect(queue.every((q, i) => i === 0 || (queue[i - 1]?.value ?? 0) >= q.value)).toBe(true);
    expect(selectQuestion(queue, { thetaAsk: (best?.value ?? 0) + 1e-9 })).toBeUndefined();
    expect(selectQuestion([], { thetaAsk: 0 })).toBeUndefined();
  });

  it("the HUD reason states the real trigger on the real training cases: contradiction only at or above the threshold", () => {
    const [one, two] = kycCases("training").map((c) => {
      const features = caseFeatures(c);
      return observation(c.id, features, KYC_HIDDEN_POLICY.evaluate(lookupFrom(features)).decisions.reviewOutcome?.action ?? "approve");
    });
    if (one === undefined || two === undefined) throw new Error("missing training case");
    const first = observeDecision({ model: REVIEW, set: buildHypothesisSet({ setId: "hs", model: REVIEW, knowledge: EMPTY_KNOWLEDGE, schemaVersion: 1, config: CONFIG }), knowledge: EMPTY_KNOWLEDGE, observation: one, config: CONFIG });
    const second = observeDecision({ model: REVIEW, set: first.set, knowledge: first.knowledge, observation: two, config: CONFIG });
    const bits = second.recent.surprise.bits;
    const hudReasons = (contradictionBits: number) =>
      generateQuestions({ model: REVIEW, set: second.set, ctx: questionContext(two), recent: second.recent, config: engineConfig({ contradictionBits }) })
        .filter((q) => q.kind === "counterfactual")
        .map((q) => describeQuestion(q).split(" · ")[0]);
    // Default threshold (3 bits) is not reached by case 2, so the HUD must not claim a contradiction.
    expect(bits).toBeLessThan(CONFIG.contradictionBits);
    expect(new Set(hudReasons(CONFIG.contradictionBits))).toEqual(new Set([QUESTION_REASONS.competing]));
    expect(new Set(hudReasons(bits))).toEqual(new Set([QUESTION_REASONS.contradiction]));
  });

  it("is deterministic", () => {
    const a = generateQuestions({ model: REVIEW, set: SET, ctx: questionContext(CASE_A), config: CONFIG });
    expect(generateQuestions({ model: REVIEW, set: SET, ctx: questionContext(CASE_A), config: CONFIG })).toEqual(a);
  });
});
