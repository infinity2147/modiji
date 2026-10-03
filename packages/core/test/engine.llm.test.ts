import { zodOutputFormat } from "@anthropic-ai/sdk/helpers/zod";
import { describe, expect, expectTypeOf, it } from "vitest";
import { z } from "zod";
import { KYC_HIDDEN_POLICY, ORACLE_MARKER } from "../src/domains/kyc/domain.oracle.server";
import {
  EMPTY_KNOWLEDGE,
  LlmAnswerSchema,
  LlmConceptProposalSchema,
  LlmRephraseSchema,
  acceptRephrase,
  applyAnswer,
  buildAnswerParserPrompt,
  buildConceptProposerPrompt,
  buildHypothesisSet,
  buildRephrasePrompt,
  conditionListToPredicate,
  generateQuestions,
  promptDomain,
  requiredPhrases,
  summarizeCandidates,
  toParsedAnswer,
  toProposedConcepts,
  typecheckPredicate,
  type LlmAnswer,
  type Question,
} from "../src";
import { CASE_A, CASE_B, CONFIG, KYC, REVIEW, questionContext } from "./engine.fixtures";

const SCHEMAS = { LlmAnswerSchema, LlmConceptProposalSchema, LlmRephraseSchema };
const SET = buildHypothesisSet({ setId: "hs-review", model: REVIEW, knowledge: { ...EMPTY_KNOWLEDGE, observations: [CASE_A, CASE_B] }, schemaVersion: 1, config: CONFIG });
const QUEUE = generateQuestions({ model: REVIEW, set: SET, ctx: questionContext(CASE_A), config: CONFIG });
const QUESTION = QUEUE.find((q) => q.target.feature === "jurisdictionRisk") as Question;
const UTTERANCE = { id: "utt-9", text: "Still enhanced review. Honestly, anything over a quarter that isn't verified goes to enhanced review, whatever the country.", t0Ms: 90_000, t1Ms: 97_500 };

/** Visits every node of a JSON schema. */
function walk(node: unknown, visit: (n: Record<string, unknown>) => void): void {
  if (Array.isArray(node)) return node.forEach((n) => walk(n, visit));
  if (typeof node !== "object" || node === null) return;
  visit(node as Record<string, unknown>);
  for (const v of Object.values(node)) walk(v, visit);
}

describe("LLM output schemas (structured outputs)", () => {
  it.each(Object.entries(SCHEMAS))("%s: every object is strict with all properties required, and nothing is recursive", (_, schema) => {
    const json = z.toJSONSchema(schema);
    let objects = 0;
    walk(json, (n) => {
      expect(n).not.toHaveProperty("$ref");
      expect(n).not.toHaveProperty("$defs");
      if (n.type === "object") {
        objects++;
        expect(n.additionalProperties).toBe(false);
        expect([...((n.required as string[] | undefined) ?? [])].sort()).toEqual(Object.keys((n.properties as object | undefined) ?? {}).sort());
      }
    });
    expect(objects).toBeGreaterThan(0);
    // The SDK helper that the Claude wrapper uses accepts it.
    expect(() => zodOutputFormat(schema)).not.toThrow();
  });
});

describe("condition lists", () => {
  it("convert to predicates that type-check against the domain", () => {
    const all = conditionListToPredicate({
      combinator: "all",
      conditions: [
        { feature: "uboOwnershipPct", op: ">", value: 25 },
        { feature: "uboVerified", op: "==", value: false },
      ],
    });
    expect(all).toEqual({ ok: true, predicate: { and: [{ ">": [{ var: "uboOwnershipPct" }, 25] }, { "==": [{ var: "uboVerified" }, false] }] } });
    const one = conditionListToPredicate({ combinator: "any", conditions: [{ feature: "jurisdictionRisk", op: "==", value: "high" }] });
    for (const r of [all, one]) expect(r.ok && typecheckPredicate(r.predicate, KYC.features)).toEqual([]);
    const any = conditionListToPredicate({ combinator: "any", conditions: [{ feature: "pep", op: "==", value: true }, { feature: "sanctionsHit", op: "==", value: true }] });
    expect(any.ok && "or" in any.predicate).toBe(true);
    expect(conditionListToPredicate({ combinator: "all", conditions: [{ feature: "owner share", op: ">", value: 1 }] })).toEqual({
      ok: false,
      reasons: ['condition 0: "owner share" is not a feature identifier'],
    });
  });
});

describe("answer parser contract", () => {
  const output: LlmAnswer = {
    survivingCandidateIds: [],
    eliminatedCandidateIds: SET.candidates.filter((c) => JSON.stringify(c.predicate).includes("jurisdictionRisk")).map((c) => c.id),
    statedRules: [
      {
        when: { combinator: "all", conditions: [{ feature: "uboOwnershipPct", op: ">", value: 25 }, { feature: "uboVerified", op: "==", value: false }] },
        action: "enhancedReview",
        kind: "decision",
        exactQuote: "anything over a quarter that isn't verified goes to enhanced review",
      },
      { when: { combinator: "all", conditions: [{ feature: "pep", op: "==", value: true }] }, action: "escalateCompliance", kind: "escalation", exactQuote: "PEPs always go up" },
    ],
    newConcepts: [],
    answeredAction: "enhancedReview",
    confidence: 0.92,
  };

  it("converts verified output to a ParsedAnswer that applies to the hypothesis set", () => {
    const { answer, rejected } = toParsedAnswer(output, { questionId: QUESTION.id, utterance: UTTERANCE, domain: KYC, pendingConcepts: [] });
    expect(rejected).toEqual([{ item: "statedRules[1]", reason: "quote is not verbatim in the answer" }]);
    expect(answer.statedRules).toHaveLength(1);
    expect(answer.statedRules[0]).toMatchObject({ t0Ms: 90_000, t1Ms: 97_500, action: "enhancedReview" });
    const applied = applyAnswer({ model: REVIEW, set: SET, knowledge: { ...EMPTY_KNOWLEDGE, observations: [CASE_A, CASE_B] }, question: QUESTION, answer, undefinedConcepts: [], config: CONFIG });
    expect(applied.statedRules[0]?.status).toBe("candidate");
    expect(applied.observation?.action).toBe("enhancedReview");
    const eliminated = new Set(answer.eliminatedCandidateIds);
    expect(eliminated.size).toBeGreaterThan(0);
    expect(applied.set.candidates.some((c) => eliminated.has(c.id))).toBe(false);
  });

  it("verifies concept proposals: verbatim quote, genuinely new, enum values present", () => {
    const transcript = [{ speaker: "expert" as const, text: "It looked like a shell company to me, and the funds trail was thin." }];
    const c = (name: string, quote: string, type: "boolean" | "enum" = "boolean", values: string[] = []) => ({ name, label: name, definition: "d", type, values, evidenceQuote: quote });
    const result = toProposedConcepts(
      { concepts: [c("shellCompany", "a shell company"), c("pep", "a shell company"), c("fundsTrail", "the money trail"), c("trailQuality", "the funds trail was thin", "enum", ["thin"])] },
      { domain: KYC, transcript, pendingConcepts: [] },
    );
    expect(result.concepts.map((x) => x.name)).toEqual(["shellCompany"]);
    expect(result.concepts[0]?.exactQuote).toBe("a shell company");
    expect(result.rejected.map((r) => r.name)).toEqual(["pep", "fundsTrail", "trailQuality"]);
  });
});

describe("prompt builders", () => {
  const domain = promptDomain(KYC);
  const prompts = [
    buildConceptProposerPrompt({
      domain,
      transcript: [{ speaker: "expert", text: UTTERANCE.text }],
      unexplained: [{ caseId: "A", action: "enhancedReview", visibleFeatures: { uboOwnershipPct: "35%" } }],
      pendingConcepts: ["shellCompany"],
    }),
    buildAnswerParserPrompt({ domain, decisionFamily: "reviewOutcome", question: QUESTION, utterance: UTTERANCE, candidates: summarizeCandidates(SET, KYC, 12) }),
    buildRephrasePrompt({ domain, question: QUESTION, targetFeature: QUESTION.target.feature ?? null, mustKeep: requiredPhrases(QUESTION, KYC) }),
  ];

  it("keep static instructions in the system string and never carry oracle data", () => {
    for (const p of prompts) {
      expect(p.system).toContain('<domain id="kycNorthstar">');
      expect(`${p.system}\n${p.user}`).not.toMatch(/oracle:/);
      expect(`${p.system}\n${p.user}`).not.toContain(ORACLE_MARKER);
    }
    expect(prompts[1]?.user).toContain(UTTERANCE.text);
    expect(prompts[1]?.user).toContain("if country risk is medium then enhancedReview");
  });

  it("accept no oracle-typed input", () => {
    type ParserInput = Parameters<typeof buildAnswerParserPrompt>[0];
    expectTypeOf(KYC_HIDDEN_POLICY.rules).not.toExtend<ParserInput["candidates"]>();
    expectTypeOf(KYC_HIDDEN_POLICY).not.toExtend<ParserInput["domain"]>();
    expectTypeOf(KYC_HIDDEN_POLICY).not.toExtend<Parameters<typeof buildConceptProposerPrompt>[0]["domain"]>();
    expect(JSON.stringify(promptDomain(KYC))).not.toMatch(/oracle:/);
  });
});

describe("rephrase hook", () => {
  it("accepts a rephrasing that keeps the target, falls back to the template otherwise", () => {
    expect(requiredPhrases(QUESTION, KYC)).toEqual(["high"]);
    const target = QUESTION.target.feature ?? null;
    expect(acceptRephrase(QUESTION, { text: "Same case but a high-risk country: what would you do?", targetFeature: target }, KYC)).toEqual({
      text: "Same case but a high-risk country: what would you do?",
      accepted: true,
    });
    const rejects = [
      { text: "Would you still send it to enhanced review if the owner were verified?", targetFeature: "uboVerified" },
      { text: "Same case, medium risk country, what now?", targetFeature: target },
      { text: Array.from({ length: 26 }, () => "high").join(" "), targetFeature: target },
    ];
    for (const r of rejects) {
      const decision = acceptRephrase(QUESTION, r, KYC);
      expect(decision.accepted).toBe(false);
      expect(decision.text).toBe(QUESTION.text);
    }
    expect(LlmRephraseSchema.safeParse({ text: "x", targetFeature: null }).success).toBe(true);
  });
});
