import { z } from "zod";
import type { DomainConfig } from "../../schemas/domain";
import type { Question } from "../../schemas/engine";
import { MAX_QUESTION_WORDS } from "../config";
import { findFeature, formatValue, wordCount } from "../describe";
import { renderDomain, type BuiltPrompt, type PromptDomain } from "./inputs";

/** Structured output of the question rephraser (Sonnet 5.5). */
export const LlmRephraseSchema = z.strictObject({
  text: z.string().describe(`The question, at most ${MAX_QUESTION_WORDS} words, one sentence or two short ones`),
  targetFeature: z.string().nullable().describe("The feature id the question is about, exactly as given; null if none was given"),
});
export type LlmRephrase = z.infer<typeof LlmRephraseSchema>;

export const REPHRASER_SYSTEM = `You rephrase a precomputed question so it sounds natural when spoken to a busy expert
at a pause in their work. You may change wording only.

Rules:
- At most ${MAX_QUESTION_WORDS} words. Plain, friendly, direct; no preamble, no apology.
- Keep the question's target: the same feature, the same values, the same case. Every phrase listed
  under <must_keep> must appear verbatim in your text.
- Do not add options, hints, hypotheses, or any new fact. Do not answer the question.
- Return targetFeature exactly as given (null if none was given).`;

/** Phrases a rephrasing must keep verbatim: the moved value of a counterfactual, the concept of a definition probe. */
export function requiredPhrases(question: Question, domain: DomainConfig): string[] {
  const feature = question.target.feature;
  if (feature === undefined) return [];
  const f = findFeature(domain, feature);
  const value = question.target.assignment?.[feature];
  if ((question.kind === "counterfactual" || question.kind === "witness") && value !== undefined) return [formatValue(f, value)];
  if (question.kind === "concept_definition") {
    const label = /“(.+?)”/.exec(question.text)?.[1];
    return label === undefined ? [] : [label];
  }
  return [];
}

export function buildRephrasePrompt(input: { domain: PromptDomain; question: Pick<Question, "kind" | "text">; targetFeature: string | null; mustKeep: readonly string[] }): BuiltPrompt {
  return {
    system: `${REPHRASER_SYSTEM}\n\n${renderDomain(input.domain)}`,
    user: [
      `<question kind="${input.question.kind}">${input.question.text}</question>`,
      `<target_feature>${input.targetFeature ?? "null"}</target_feature>`,
      `<must_keep>${input.mustKeep.map((p) => `"${p}"`).join(", ")}</must_keep>`,
    ].join("\n"),
  };
}

export type RephraseDecision = { text: string; accepted: true } | { text: string; accepted: false; reason: string };

/**
 * The rephrase hook's gate: the rephrasing replaces the template text only if it is ≤25 words,
 * echoes the same target feature, and keeps every required phrase; otherwise the deterministic
 * template stands. The question's id, target and value never change.
 */
export function acceptRephrase(question: Question, output: LlmRephrase, domain: DomainConfig): RephraseDecision {
  const keep = (reason: string): RephraseDecision => ({ text: question.text, accepted: false, reason });
  const text = output.text.trim();
  if (text === "") return keep("empty rephrasing");
  if (wordCount(text) > MAX_QUESTION_WORDS) return keep(`longer than ${MAX_QUESTION_WORDS} words`);
  if (output.targetFeature !== (question.target.feature ?? null)) return keep("target feature changed");
  const missing = requiredPhrases(question, domain).filter((p) => !text.toLowerCase().includes(p.toLowerCase()));
  if (missing.length > 0) return keep(`dropped ${missing.map((p) => `"${p}"`).join(", ")}`);
  return { text, accepted: true };
}
