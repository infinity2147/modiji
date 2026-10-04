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
- The answer may arrive as several transcript <segment>s (the speech recognizer split it). Read them as one
  answer, but copy each exactQuote from a single segment: a quote that runs across two segments is rejected.
- The expert may answer in another language. Then <expert_answer> holds their original words and
  <english_translation> a machine translation, given only to help you understand them: read both, but
  copy exactQuote and evidenceQuote character for character from <expert_answer>, in its own script —
  never from the translation, never transliterated. A quote that is not in the original is rejected.
Never invent features, actions, thresholds or quotes. Everything you return is verified by code.`;

/**
 * One transcript segment of the answer (no `system_control` traffic). Its span bounds every quote taken
 * from it. `text` is always the expert's original words; for a non-English answer, `translation` (when
 * one was verified) is its English machine translation, shown to the parser for meaning only.
 */
export type AnsweredUtterance = { id: string; text: string; t0Ms: number; t1Ms: number; language?: ExpertLanguage; translation?: string };

/**
 * The answer: its first transcript segment (`utterance`) and the segments that continued it until the
 * answer window closed (`continuation`, in order; ASR splits long answers at sentence boundaries).
 */
export type AnswerSegments = { utterance: AnsweredUtterance; continuation?: readonly AnsweredUtterance[] };

export function buildAnswerParserPrompt(
  input: {
    domain: PromptDomain;
    decisionFamily: string;
    question: { id: string; kind: string; text: string };
    candidates: readonly CandidateSummary[];
  } & AnswerSegments,
): BuiltPrompt {
  return {
    system: `${ANSWER_PARSER_SYSTEM}\n\n${renderDomain(input.domain)}`,
    user: [
      `<decision_family>${input.decisionFamily}</decision_family>`,
      `<question kind="${input.question.kind}">${input.question.text}</question>`,
      "<candidates>",
      renderCandidates(input.candidates),
      "</candidates>",
      ...expertAnswer(input.utterance, input.continuation ?? []),
    ].join("\n"),
  };
}

const english = (u: AnsweredUtterance): boolean => u.language === undefined || u.language === "en";

function translationLine(u: AnsweredUtterance, segment?: number): string {
  const n = segment === undefined ? "" : ` segment="${segment}"`;
  return u.translation === undefined
    ? `<english_translation${n}>unavailable: read the original</english_translation>`
    : `<english_translation${n} note="machine translation, for meaning only; never quote it">${u.translation}</english_translation>`;
}

function expertAnswer(first: AnsweredUtterance, continuation: readonly AnsweredUtterance[]): string[] {
  if (continuation.length === 0) {
    if (english(first)) return [`<expert_answer>${first.text}</expert_answer>`];
    return [`<expert_answer language="${first.language}">${first.text}</expert_answer>`, translationLine(first)];
  }
  const segments = [first, ...continuation];
  return [
    `<expert_answer segments="${segments.length}">`,
    ...segments.flatMap((u, i) =>
      english(u)
        ? [`<segment n="${i + 1}">${u.text}</segment>`]
        : [`<segment n="${i + 1}" language="${u.language}">${u.text}</segment>`, translationLine(u, i + 1)],
    ),
    "</expert_answer>",
  ];
}

export type AnswerConversion = { answer: ParsedAnswer; rejected: { item: string; reason: string }[] };

/**
 * Code-side conversion to the engine's `ParsedAnswer`: condition lists become predicates that must
 * type-check against the domain, actions must be domain actions, the polarity becomes the stated
 * rule's effect and kind (`statedShape`), every quote must be verbatim in ONE transcript segment's
 * original text — never in a translation, never across a segment boundary — and takes that segment's
 * span as its timestamps (and, for a later segment, its id), so each quote's evidence is a single
 * `utterance.transcript` entry that contains it; concepts go through `toProposedConcepts`. Anything
 * that fails is returned in `rejected` with a reason. Family-level checks (the action belongs to the
 * asked family) happen in `applyAnswer` and promotion.
 */
export function toParsedAnswer(
  output: LlmAnswer,
  ctx: { questionId: string; domain: DomainConfig; pendingConcepts: readonly string[] } & AnswerSegments,
): AnswerConversion {
  const rejected: AnswerConversion["rejected"] = [];
  const { utterance } = ctx;
  const segments = [utterance, ...(ctx.continuation ?? [])];
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
    const segment = segments.find((u) => containsQuote(u.text, r.exactQuote));
    if (segment === undefined)
      return reject(segments.length === 1 ? "quote is not verbatim in the answer" : "quote is not verbatim within one segment of the answer");
    const rule = StatedRuleSchema.safeParse({
      predicate: predicate.predicate,
      action: action.data,
      ...shape,
      exactQuote: r.exactQuote.trim(),
      t0Ms: segment.t0Ms,
      t1Ms: segment.t1Ms,
      ...(segment !== utterance && { utteranceId: segment.id }),
    });
    if (rule.success) statedRules.push(rule.data);
    else reject(rule.error.issues.map((issue) => issue.message).join("; "));
  });
  const concepts = toProposedConcepts(
    { concepts: output.newConcepts },
    { domain: ctx.domain, transcript: segments.map((u) => ({ speaker: "expert" as const, text: u.text })), pendingConcepts: ctx.pendingConcepts },
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
    ...(segments.length > 1 && { segmentIds: segments.map((u) => u.id) }),
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
        : { kind: "guardrail", effect: { type: "require_approval", role: r.approvalRole, action } };
    case "recommend":
      return r.kind === "guardrail"
        ? { reason: "a recommendation is not a guardrail: a guardrail forbids an action or requires approval" }
        : { kind: r.kind, effect: { type: "recommend", action } };
  }
}
