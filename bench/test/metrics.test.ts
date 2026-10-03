import { ActionIdSchema, PredicateSchema, type Assignment, type Predicate } from "@vashistha/core";
import { describe, expect, it } from "vitest";
import { statementId, type ExpertStatement, type TranscriptEntry } from "../src/expert";
import { fitPolicy } from "../src/learner";
import { behaviouralMetrics, labelHeldout, leafCount, questionMetrics, rulesRecovered } from "../src/metrics";

const CLEAN = {
  entityType: "individual",
  customerStatus: "new",
  accountAgeMonths: 0,
  jurisdictionRisk: "low",
  uboOwnershipPct: 100,
  uboVerified: true,
  pep: false,
  sanctionsHit: false,
  adverseMedia: false,
  sourceOfFunds: "verified",
  expectedMonthlyVolume: 5000,
  riskRating: "unrated",
} as Assignment;

const at = (patch: Record<string, unknown>): Assignment => ({ ...CLEAN, ...patch }) as Assignment;

/** A learner that was only told "sanctions hit → reject" and that the default is approve. */
function sanctionsOnly(predicate: Predicate): ReturnType<typeof fitPolicy> {
  const statement: ExpertStatement = {
    id: statementId("nsrp.sanctions.reject"),
    rule: { predicate, action: ActionIdSchema.parse("reject"), kind: "decision", exactQuote: "If sanctions match, reject.", t0Ms: 0, t1Ms: 0 },
    effect: { type: "recommend", action: ActionIdSchema.parse("reject") },
    priority: 100,
    overrides: [],
  };
  return fitPolicy({ observations: [], statements: [statement], statedDefault: ActionIdSchema.parse("approve") });
}

describe("metrics on hand-made cases", () => {
  const heldout = labelHeldout([
    { caseId: "sanctions", features: at({ sanctionsHit: true }) }, // oracle reject; learner reject
    { caseId: "pep", features: at({ pep: true }) }, // oracle escalate; learner approves: unsafe, guardrail missed
    { caseId: "clean", features: at({}) }, // oracle approve; learner approve
    { caseId: "high-risk", features: at({ jurisdictionRisk: "high" }) }, // oracle enhanced review; learner approves: unsafe
  ]);

  it("ground truth is what NSRP-1 says", () => {
    expect(heldout.map((c) => c.verdict.action)).toEqual(["reject", "escalateCompliance", "approve", "enhancedReview"]);
  });

  it("fidelity, unsafe FN rate and guardrail recall", () => {
    const m = behaviouralMetrics(sanctionsOnly(PredicateSchema.parse({ "==": [{ var: "sanctionsHit" }, true] })), heldout);
    expect(m.fidelity).toBe(2 / 4);
    expect(m.unsafeFnRate).toBe(2 / 3);
    expect(m.guardrailRecall).toBe(1 / 2);
  });

  it("a stated guardrail that blocks approving counts as blocked even when the decision is approve", () => {
    const policy = fitPolicy({
      observations: [],
      statements: [
        {
          id: statementId("nsrp.pep.approval"),
          rule: { predicate: PredicateSchema.parse({ "==": [{ var: "pep" }, true] }), action: ActionIdSchema.parse("approve"), kind: "guardrail", exactQuote: "PEP needs sign-off.", t0Ms: 0, t1Ms: 0 },
          effect: { type: "require_approval", role: "compliance_officer" },
          priority: 90,
          overrides: [],
        },
      ],
      statedDefault: ActionIdSchema.parse("approve"),
    });
    const m = behaviouralMetrics(policy, heldout);
    expect(m.unsafeFnRate).toBe(2 / 3); // sanctions and high-risk approved; PEP blocked by the guardrail
    expect(m.guardrailRecall).toBe(1 / 2);
  });

  it("Z3 recovery counts logically equivalent rules with the same effect, not syntax", async () => {
    expect(await rulesRecovered(sanctionsOnly(PredicateSchema.parse({ "!=": [{ var: "sanctionsHit" }, false] })), new Map())).toBe(1);
    expect(await rulesRecovered(sanctionsOnly(PredicateSchema.parse({ "==": [{ var: "pep" }, true] })), new Map())).toBe(0);
  });

  it("questions and interruptions", () => {
    const why = { kind: "why", caseId: "c" } as const;
    const answer = { kind: "why" as const, statements: [] };
    const transcript: TranscriptEntry[] = [
      { question: why, timing: { phase: "live", pause: 0 }, answer },
      { question: why, timing: { phase: "live", pause: 0 }, answer },
      { question: why, timing: { phase: "live", pause: 3 }, answer },
      { question: { kind: "counterfactual", caseId: "x", features: CLEAN }, timing: { phase: "debrief" }, answer: { kind: "counterfactual", action: ActionIdSchema.parse("approve") } },
    ];
    expect(questionMetrics(transcript)).toEqual({ questions: 4, whyQuestions: 3, counterfactualQuestions: 1, interruptions: 2 });
  });

  it("counts leaf conditions", () => {
    expect(leafCount(PredicateSchema.parse({ and: [{ "==": [{ var: "pep" }, true] }, { or: [{ "==": [{ var: "sanctionsHit" }, true] }, { "!": [{ "==": [{ var: "adverseMedia" }, true] }] }] }] }))).toBe(3);
  });
});
