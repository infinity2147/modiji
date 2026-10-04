import { describe, expect, it } from "vitest";
import {
  EMPTY_KNOWLEDGE,
  HypothesisSetSchema,
  applyAnswer,
  buildHypothesisSet,
  featuresReferenced,
  generateQuestions,
  predictedAction,
  recordLookup,
  type FamilyKnowledge,
  type HypothesisSet,
  type ParsedAnswer,
  type Predicate,
  type ProposedConcept,
  type Question,
  type StatedRule,
} from "../src";
import { CASE_A, CASE_B, CONFIG, REVIEW, questionContext } from "./engine.fixtures";

const KNOWLEDGE: FamilyKnowledge = { ...EMPTY_KNOWLEDGE, observations: [CASE_A, CASE_B] };
const SET: HypothesisSet = buildHypothesisSet({ setId: "hs-review", model: REVIEW, knowledge: KNOWLEDGE, schemaVersion: 1, config: CONFIG });
const QUEUE = generateQuestions({ model: REVIEW, set: SET, ctx: questionContext(CASE_A), config: CONFIG });
const counterfactual = (feature: string, value: unknown): Question => {
  const q = QUEUE.find((x) => x.target.feature === feature && x.target.assignment?.[feature as never] === value);
  if (q === undefined) throw new Error(`no counterfactual on ${feature}=${String(value)}`);
  return q;
};
const answer = (question: Question, over: Partial<ParsedAnswer> = {}): ParsedAnswer => ({
  questionId: question.id,
  utteranceId: "utt-1",
  survivingCandidateIds: [],
  eliminatedCandidateIds: [],
  statedRules: [],
  newConcepts: [],
  confidence: 0.9,
  ...over,
});
const apply = (question: Question, parsed: ParsedAnswer, undefinedConcepts: ProposedConcept[] = []) =>
  applyAnswer({ model: REVIEW, set: SET, knowledge: KNOWLEDGE, question, answer: parsed, undefinedConcepts, config: CONFIG });
const jurisdictionIds = SET.candidates.filter((c) => featuresReferenced(c.predicate).join() === "jurisdictionRisk").map((c) => c.id);
const stated = (predicate: unknown, action: string, quote = "over a quarter and not verified goes to enhanced review"): StatedRule =>
  ({ predicate: predicate as Predicate, action, kind: "decision", effect: { type: "recommend", action }, exactQuote: quote, t0Ms: 1000, t1Ms: 4000 }) as StatedRule;

describe("applyAnswer", () => {
  it("removes eliminated candidates and renormalises the rest (relative weights unchanged)", () => {
    const q = counterfactual("jurisdictionRisk", "high");
    const result = apply(q, answer(q, { eliminatedCandidateIds: jurisdictionIds }));
    expect(result.status).toBe("applied");
    expect(HypothesisSetSchema.safeParse(result.set).success).toBe(true);
    expect(result.set.candidates.some((c) => jurisdictionIds.includes(c.id))).toBe(false);
    expect(result.knowledge.eliminatedIds).toEqual(expect.arrayContaining(jurisdictionIds));
    expect(result.set.normalizationVersion).toBe(SET.normalizationVersion + 1);
    const [x, y] = result.set.candidates;
    const before = (id: string | undefined) => SET.candidates.find((c) => c.id === id)?.weight ?? Number.NaN;
    expect((x?.weight ?? 0) / (y?.weight ?? 1)).toBeCloseTo(before(x?.id) / before(y?.id), 9);
    expect(result.unexplained).toBe(false);
  });

  it("treats the answered action of a counterfactual as an observation of the asked case", () => {
    const q = counterfactual("jurisdictionRisk", "high");
    const result = apply(q, answer(q, { answeredAction: "enhancedReview" as never }));
    expect(result.observation).toEqual({ id: "utt-1", caseId: "A", features: q.target.assignment, action: "enhancedReview" });
    expect(result.knowledge.observations).toHaveLength(3);
    // Jurisdiction-only explanations predicted approve there; their mass collapses.
    const jurisdictionMass = (s: HypothesisSet) => s.candidates.filter((c) => featuresReferenced(c.predicate).join() === "jurisdictionRisk").reduce((m, c) => m + c.weight, 0);
    expect(jurisdictionMass(SET)).toBeGreaterThan(0.15);
    expect(jurisdictionMass(result.set)).toBeLessThan(jurisdictionMass(SET) / 10);
    const top = [...result.set.candidates].sort((a, b) => b.weight - a.weight)[0];
    expect(top && predictedAction(REVIEW, top, recordLookup(q.target.assignment ?? {}))).toBe("enhancedReview");
  });

  it("turns a valid stated rule into an expert_statement candidate", () => {
    const q = counterfactual("jurisdictionRisk", "high");
    const rule = stated({ and: [{ ">": [{ var: "uboOwnershipPct" }, 25] }, { "==": [{ var: "uboVerified" }, false] }] }, "enhancedReview");
    const result = apply(q, answer(q, { statedRules: [rule] }));
    const outcome = result.statedRules[0];
    expect(outcome?.status).toBe("candidate");
    const candidate = result.set.candidates.find((c) => outcome?.status === "candidate" && c.id === outcome.candidateId);
    expect(candidate?.origin).toBe("expert_statement");
    expect(candidate?.complexity).toBe(2);
    expect(result.knowledge.statedCandidates.map((c) => c.id)).toContain(candidate?.id);
  });

  it("applies explicit statements on their own evidence at low parse confidence; only inferences are gated (live bug #5)", () => {
    const q = counterfactual("jurisdictionRisk", "high");
    const decision = stated({ and: [{ ">": [{ var: "uboOwnershipPct" }, 25] }, { "==": [{ var: "uboVerified" }, false] }] }, "enhancedReview");
    const guardrail = {
      ...stated({ "==": [{ var: "jurisdictionRisk" }, "high"] }, "approve", "never approve a customer from a high-risk country"),
      kind: "guardrail",
      effect: { type: "forbid", action: "approve" },
    } as StatedRule;
    const result = apply(q, answer(q, { statedRules: [decision, guardrail], eliminatedCandidateIds: jurisdictionIds, confidence: 0.4 }));
    expect(result.status).toBe("low_confidence");
    expect(result.statedRules.map((o) => o.status)).toEqual(["candidate", "guardrail"]);
    const added = result.statedRules[0];
    expect(result.set.candidates.some((c) => added?.status === "candidate" && c.id === added.candidateId && c.origin === "expert_statement")).toBe(true);
    // The parser's inferred eliminations are not applied.
    expect(result.knowledge.eliminatedIds).toEqual([]);
    expect(jurisdictionIds.every((id) => result.set.candidates.some((c) => c.id === id))).toBe(true);
  });

  it("rejects an invalid stated rule with reasons instead of dropping it", () => {
    const q = counterfactual("jurisdictionRisk", "high");
    const result = apply(
      q,
      answer(q, {
        statedRules: [
          stated({ ">": [{ var: "ownerTenure" }, 3] }, "enhancedReview"),
          stated({ ">": [{ var: "jurisdictionRisk" }, 3] }, "enhancedReview"),
          stated({ "==": [{ var: "pep" }, true] }, "rateHigh"),
          stated({ "==": [{ var: "pep" }, false] }, "approve"),
        ],
      }),
    );
    expect(result.statedRules.map((o) => o.status)).toEqual(["rejected", "rejected", "rejected", "rejected"]);
    const reasons = result.statedRules.flatMap((o) => (o.status === "rejected" ? o.reasons : []));
    expect(reasons.some((r) => r.includes('undeclared feature "ownerTenure"'))).toBe(true);
    expect(reasons.some((r) => r.includes("requires a numeric operand"))).toBe(true);
    expect(reasons.some((r) => r.includes("not an action of family reviewOutcome"))).toBe(true);
    expect(reasons.some((r) => r.includes("family default"))).toBe(true);
    expect(result.set.candidates.every((c) => c.origin === "enumerated")).toBe(true);
  });

  it("lists new concepts as undefined (not features), and reports ones that are not new", () => {
    const q = counterfactual("jurisdictionRisk", "high");
    const concept = (name: string): ProposedConcept => ({ name, label: name, definition: "as the expert uses it", type: "boolean" });
    const result = apply(q, answer(q, { newConcepts: [concept("sourceOfWealthDocumented"), concept("pep"), concept("shellCompany")] }), [concept("shellCompany")]);
    expect(result.undefinedConcepts.map((c) => c.name)).toEqual(["shellCompany", "sourceOfWealthDocumented"]);
    expect(result.ignored).toEqual([
      { item: "pep", reason: "already a feature of the domain" },
      { item: "shellCompany", reason: "already awaiting confirmation" },
    ]);
  });

  it("surfaces 'unexplained' with an empty set when every candidate is eliminated — nothing is invented", () => {
    const q = counterfactual("jurisdictionRisk", "high");
    const result = apply(q, answer(q, { eliminatedCandidateIds: SET.candidates.map((c) => c.id) }));
    expect(result.unexplained).toBe(true);
    expect(result.set.candidates).toEqual([]);
    expect(HypothesisSetSchema.safeParse(result.set).success).toBe(true);
  });

  it("ignores unknown or contradictory ids, a low-confidence parse, and an answered action without a case", () => {
    const q = counterfactual("jurisdictionRisk", "high");
    const [first] = jurisdictionIds;
    const mixed = apply(q, answer(q, { eliminatedCandidateIds: ["cand_nope", first ?? ""], survivingCandidateIds: [first ?? ""] }));
    expect(mixed.ignored.map((i) => i.reason)).toEqual(["not a candidate of this hypothesis set", "listed as both surviving and eliminated"]);
    expect(mixed.set.candidates.map((c) => c.id)).toContain(first);

    const low = apply(q, answer(q, { eliminatedCandidateIds: jurisdictionIds, answeredAction: "enhancedReview" as never, confidence: 0.2 }));
    expect(low.status).toBe("low_confidence");
    expect(low.set).toBe(SET);
    expect(low.observation).toBeUndefined();
    expect(low.ignored).toHaveLength(jurisdictionIds.length + 1);
    expect(low.ignored.every((i) => i.reason.startsWith("parse confidence 0.2 is below 0.5"))).toBe(true);

    const why = { ...q, kind: "why_probe" as const, target: { candidateIds: [] } };
    const noCase = apply(why, answer(why, { answeredAction: "approve" as never }));
    expect(noCase.observation).toBeUndefined();
    expect(noCase.ignored[0]?.reason).toBe("a why_probe question asks about no concrete case");
    expect(() => apply(q, { ...answer(q), questionId: "other" })).toThrow(RangeError);
  });
});
