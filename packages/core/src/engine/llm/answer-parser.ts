import { z } from "zod";
import { ParsedAnswerSchema, type ParsedAnswer, type StatedRule } from "../../schemas/engine";
import { ActionIdSchema, IdSchema } from "../../schemas/primitives";
import type { DomainConfig } from "../../schemas/domain";
import { containsQuote } from "../describe";
import { LlmConceptSchema, toProposedConcepts } from "./concepts";
import { LlmConditionListSchema, conditionListToPredicate } from "./conditions";
import { renderCandidates, renderDomain, type BuiltPrompt, type CandidateSummary, type PromptDomain } from "./inputs";

/** Structured output of the answer parser (Sonnet 5.5). Flat and strict; nullable instead of optional. */
export const LlmStatedRuleSchema = z.strictObject({
  when: LlmConditionListSchema,
  action: z.string().describe("Action id from the domain"),
  kind: z.enum(["decision", "guardrail", "escalation", "exception"]),
  exactQuote: z.string().describe("The expert's words stating the rule, copied verbatim from the answer"),
});
export const LlmAnswerSchema = z.strictObject({
  survivingCandidateIds: z.array(z.string()).describe("Candidate ids the answer is consistent with"),
  eliminatedCandidateIds: z.array(z.string()).describe("Candidate ids the answer clearly rules out"),
  statedRules: z.array(LlmStatedRuleSchema).describe("Rules the expert stated explicitly; [] if none"),
  newConcepts: z.array(LlmConceptSchema).describe("Concepts the expert used that the feature list lacks; [] if none"),
  answeredAction: z.string().nullable().describe("For a 'what would you decide' question: the action id the expert chose; else null"),
  confidence: z.number().min(0).max(1).describe("How unambiguous the answer is, 0..1"),
});
export type LlmAnswer = z.infer<typeof LlmAnswerSchema>;

export const ANSWER_PARSER_SYSTEM = `You turn an expert's spoken answer into structured data for an apprentice system.
You are a careful reader, not a decision maker: report only what the expert actually said.

You receive the question that was asked, the expert's answer, and the competing candidate
explanations ("if <condition> then <action>, otherwise the family default") with their ids.

Rules:
- eliminatedCandidateIds: only candidates the answer clearly contradicts. If unsure, leave them out.
- survivingCandidateIds: candidates the answer is consistent with.
- statedRules: only rules the expert stated explicitly. Express the condition with the listed feature ids,
  operators (==, !=, <, <=, >, >=) and values exactly as listed (numbers without units). Use combinator
  "all" for "and", "any" for "or". Copy the expert's words verbatim into exactQuote.
- newConcepts: notions the expert relied on that no listed feature captures; quote them verbatim.
- answeredAction: for a "what would you decide" question, the action id the expert chose; otherwise null.
- confidence: low when the answer is hedged, off-topic or ambiguous.
Never invent features, actions, thresholds or quotes. Everything you return is verified by code.`;

/** The answered utterance as transcribed (no `system_control` traffic). Its span bounds every quote. */
export type AnsweredUtterance = { id: string; text: string; t0Ms: number; t1Ms: number };

export function buildAnswerParserPrompt(input: {
  domain: PromptDomain;
  decisionFamily: string;
  question: { id: string; kind: string; text: string };
  utterance: AnsweredUtterance;
  candidates: readonly CandidateSummary[];
}): BuiltPrompt {
  return {
    system: `${ANSWER_PARSER_SYSTEM}\n\n${renderDomain(input.domain)}`,
    user: [
      `<decision_family>${input.decisionFamily}</decision_family>`,
      `<question kind="${input.question.kind}">${input.question.text}</question>`,
      "<candidates>",
      renderCandidates(input.candidates),
      "</candidates>",
      `<expert_answer>${input.utterance.text}</expert_answer>`,
    ].join("\n"),
  };
}

export type AnswerConversion = { answer: ParsedAnswer; rejected: { item: string; reason: string }[] };

/**
 * Code-side conversion to the engine's `ParsedAnswer`: condition lists become predicates, action
 * ids are checked for syntax, every quote must be verbatim in the utterance (its timestamps are the
 * utterance span — the quote lies within it), concepts go through `toProposedConcepts`. Anything
 * that fails is returned in `rejected` with a reason. Domain type-checks of stated predicates
 * happen in `applyAnswer`.
 */
export function toParsedAnswer(
  output: LlmAnswer,
  ctx: { questionId: string; utterance: AnsweredUtterance; domain: DomainConfig; pendingConcepts: readonly string[] },
): AnswerConversion {
  const rejected: AnswerConversion["rejected"] = [];
  const { utterance } = ctx;
  const statedRules: StatedRule[] = [];
  output.statedRules.forEach((r, i) => {
    const item = `statedRules[${i}]`;
    const predicate = conditionListToPredicate(r.when);
    const action = ActionIdSchema.safeParse(r.action);
    if (!predicate.ok) rejected.push({ item, reason: predicate.reasons.join("; ") });
    else if (!action.success) rejected.push({ item, reason: `"${r.action}" is not an action identifier` });
    else if (!containsQuote(utterance.text, r.exactQuote)) rejected.push({ item, reason: "quote is not verbatim in the answer" });
    else statedRules.push({ predicate: predicate.predicate, action: action.data, kind: r.kind, exactQuote: r.exactQuote.trim(), t0Ms: utterance.t0Ms, t1Ms: utterance.t1Ms });
  });
  const concepts = toProposedConcepts(
    { concepts: output.newConcepts },
    { domain: ctx.domain, transcript: [{ speaker: "expert", text: utterance.text }], pendingConcepts: ctx.pendingConcepts },
  );
  for (const r of concepts.rejected) rejected.push({ item: `newConcepts.${r.name}`, reason: r.reason });
  let answeredAction: ParsedAnswer["answeredAction"];
  if (output.answeredAction !== null) {
    const a = ActionIdSchema.safeParse(output.answeredAction);
    if (a.success) answeredAction = a.data;
    else rejected.push({ item: "answeredAction", reason: `"${output.answeredAction}" is not an action identifier` });
  }
  const ids = (list: readonly string[], field: string): string[] =>
    list.filter((id) => {
      const ok = IdSchema.safeParse(id).success;
      if (!ok) rejected.push({ item: field, reason: "not a candidate id" });
      return ok;
    });
  const answer = ParsedAnswerSchema.parse({
    questionId: ctx.questionId,
    utteranceId: utterance.id,
    survivingCandidateIds: ids(output.survivingCandidateIds, "survivingCandidateIds"),
    eliminatedCandidateIds: ids(output.eliminatedCandidateIds, "eliminatedCandidateIds"),
    statedRules,
    newConcepts: concepts.concepts,
    ...(answeredAction !== undefined && { answeredAction }),
    confidence: output.confidence,
  });
  return { answer, rejected };
}
