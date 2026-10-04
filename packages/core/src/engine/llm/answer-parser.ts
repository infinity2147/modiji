import { z } from "zod";
import { APPROVAL_ROLES, ParsedAnswerSchema, StatedRuleSchema, type ParsedAnswer, type StatedRule, type StatedRuleEffect } from "../../schemas/engine";
import { ActionIdSchema, IdSchema } from "../../schemas/primitives";
import type { DomainConfig } from "../../schemas/domain";
import type { ExpertLanguage } from "../../schemas/expert";
import { typecheckPredicate } from "../../logic/typecheck";
import { containsQuote } from "../describe";
import { LlmConceptSchema, toProposedConcepts } from "./concepts";
import { LlmConditionListSchema, conditionListToPredicate } from "./conditions";
import { renderCandidates, renderDomain, type BuiltPrompt, type CandidateSummary, type PromptDomain } from "./inputs";

/** Structured output of the answer parser (Sonnet 5.5). Flat and strict; nullable instead of optional. */
export const LlmStatedRuleSchema = z.strictObject({
  when: LlmConditionListSchema,
  polarity: z
    .enum(["recommend", "forbid", "require_approval"])
    .describe("forbid: the action must never be taken; require_approval: the action needs someone's sign-off first; recommend: the action to take"),
  action: z.string().describe("Action id from the domain: the action to take (recommend), the forbidden action (forbid), or the action that needs sign-off (require_approval)"),
  approvalRole: z.enum(APPROVAL_ROLES).nullable().describe("require_approval only: who must sign off; null otherwise"),
  kind: z.enum(["decision", "guardrail", "escalation", "exception"]).describe("guardrail for forbid/require_approval; otherwise decision, exception or escalation"),
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
- polarity decides what a stated rule enforces; read it carefully:
  * a prohibition ("never approve …", "don't approve …", "do not …", "must not …", "can't be approved")
    is polarity "forbid" with the action that must NOT be taken, kind "guardrail". Never turn a
    prohibition into a recommendation of the same action.
  * a sign-off requirement ("needs compliance sign-off", "escalate before approving", "only with a senior
    reviewer's approval") is polarity "require_approval": action = the action that needs sign-off,
    approvalRole = who signs off (${APPROVAL_ROLES.join(", ")}), kind "guardrail".
  * otherwise polarity "recommend" with the action to take, approvalRole null, kind "decision",
    "exception" (an exception to another rule) or "escalation" (the action escalates the case).
  * one answer may state several rules: a prohibition plus what to do instead ("I never approve those;
    they go to enhanced review") is two stated rules — a "forbid" and a "recommend" — each quoting its
    own words. Never fold a prohibition into the recommendation.
- newConcepts: notions the expert relied on that no listed feature captures; quote them verbatim.
- answeredAction: for a "what would you decide" question, the action id the expert chose; otherwise null.
- confidence: low when the answer is hedged, off-topic or ambiguous.
- The expert may answer in another language. Then <expert_answer> holds their original words and
  <english_translation> a machine translation, given only to help you understand them: read both, but
  copy exactQuote and evidenceQuote character for character from <expert_answer>, in its own script —
  never from the translation, never transliterated. A quote that is not in the original is rejected.
Never invent features, actions, thresholds or quotes. Everything you return is verified by code.`;

/**
 * The answered utterance as transcribed (no `system_control` traffic). Its span bounds every quote.
 * `text` is always the expert's original words; for a non-English answer, `translation` (when one was
 * verified) is its English machine translation, shown to the parser for meaning only.
 */
export type AnsweredUtterance = { id: string; text: string; t0Ms: number; t1Ms: number; language?: ExpertLanguage; translation?: string };

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
      ...expertAnswer(input.utterance),
    ].join("\n"),
  };
}

function expertAnswer(u: AnsweredUtterance): string[] {
  if (u.language === undefined || u.language === "en") return [`<expert_answer>${u.text}</expert_answer>`];
  return [
    `<expert_answer language="${u.language}">${u.text}</expert_answer>`,
    u.translation === undefined
      ? "<english_translation>unavailable: read the original</english_translation>"
      : `<english_translation note="machine translation, for meaning only; never quote it">${u.translation}</english_translation>`,
  ];
}

export type AnswerConversion = { answer: ParsedAnswer; rejected: { item: string; reason: string }[] };

/**
 * Code-side conversion to the engine's `ParsedAnswer`: condition lists become predicates that must
 * type-check against the domain, actions must be domain actions, the polarity becomes the stated
 * rule's effect and kind (`statedShape`), every quote must be verbatim in the utterance's original
 * text — never in its translation (its timestamps are the utterance span — the quote lies within it), concepts go through
 * `toProposedConcepts`. Anything that fails is returned in `rejected` with a reason. Family-level
 * checks (the action belongs to the asked family) happen in `applyAnswer` and promotion.
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
    const reject = (reason: string): void => void rejected.push({ item, reason });
    const predicate = conditionListToPredicate(r.when);
    if (!predicate.ok) return reject(predicate.reasons.join("; "));
    const issues = typecheckPredicate(predicate.predicate, ctx.domain.features);
    if (issues.length > 0) return reject(issues.map((issue) => `predicate ${issue.path || "/"}: ${issue.message}`).join("; "));
    const action = ActionIdSchema.safeParse(r.action);
    if (!action.success || !ctx.domain.actions.some((a) => a.id === action.data)) return reject(`"${r.action}" is not an action of the domain`);
    const shape = statedShape(r, action.data);
    if ("reason" in shape) return reject(shape.reason);
    if (!containsQuote(utterance.text, r.exactQuote)) return reject("quote is not verbatim in the answer");
    const rule = StatedRuleSchema.safeParse({ predicate: predicate.predicate, action: action.data, ...shape, exactQuote: r.exactQuote.trim(), t0Ms: utterance.t0Ms, t1Ms: utterance.t1Ms });
    if (rule.success) statedRules.push(rule.data);
    else reject(rule.error.issues.map((issue) => issue.message).join("; "));
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

/**
 * Kind and effect of a stated rule from the parser's polarity. Stop-rules (forbid, require_approval)
 * are guardrails whatever kind the parser gave; a recommendation is never a guardrail, and a sign-off
 * needs a role from the fixed list.
 */
function statedShape(
  r: z.infer<typeof LlmStatedRuleSchema>,
  action: StatedRule["action"],
): { kind: StatedRule["kind"]; effect: StatedRuleEffect } | { reason: string } {
  switch (r.polarity) {
    case "forbid":
      return { kind: "guardrail", effect: { type: "forbid", action } };
    case "require_approval":
      return r.approvalRole === null
        ? { reason: `require_approval needs an approval role (${APPROVAL_ROLES.join(", ")})` }
        : { kind: "guardrail", effect: { type: "require_approval", role: r.approvalRole } };
    case "recommend":
      return r.kind === "guardrail"
        ? { reason: "a recommendation is not a guardrail: a guardrail forbids an action or requires approval" }
        : { kind: r.kind, effect: { type: "recommend", action } };
  }
}
