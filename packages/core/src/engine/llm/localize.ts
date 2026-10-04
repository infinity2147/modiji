import { z } from "zod";
import { detectLanguage } from "../../language/detect";
import { EXPERT_LANGUAGE_LABELS, type ExpertLanguage } from "../../schemas/expert";
import type { Question } from "../../schemas/engine";
import type { BuiltPrompt } from "./inputs";

/**
 * Questions in the expert's language (plan §7.11; Sonnet 5.5). Every question is computed in English
 * (templates, rephrasing, gate); for an expert who speaks another language the final English text is
 * translated once, before it is queued. The translation becomes the question's `text` — the only text
 * the gate authorises and the agent speaks — and the English original is kept as `textEnglish`. Code
 * accepts a translation only within the question's bounds; otherwise the English question stands.
 */

/** Structured output of the question localizer. */
export const LlmLocalizedQuestionSchema = z.strictObject({
  text: z.string().describe("The question in the target language"),
});
export type LlmLocalizedQuestion = z.infer<typeof LlmLocalizedQuestionSchema>;

/** `QuestionSchema.text` bound. */
export const MAX_LOCALIZED_QUESTION_CHARS = 600;

export const LOCALIZER_SYSTEM = `You translate a question that an apprentice system will speak aloud to a busy back-office expert.

Rules:
- Translate the English question into the requested language, in its native script, as a native speaker
  would naturally say it at work. One or two short sentences.
- Keep the meaning exactly: the same case, field, value and decision. Do not add options, hints or facts,
  and do not answer the question.
- Keep every number as written, in Western digits (e.g. 25, 10000). Domain terms with no everyday
  equivalent (KYC, EDD, UBO, PEP, high-risk) may stay in English.
- Return only the translated question.`;

export function buildLocalizePrompt(input: { question: Pick<Question, "kind" | "text">; language: ExpertLanguage }): BuiltPrompt {
  return {
    system: LOCALIZER_SYSTEM,
    user: [
      `<target_language code="${input.language}">${EXPERT_LANGUAGE_LABELS[input.language]}</target_language>`,
      `<question kind="${input.question.kind}">${input.question.text}</question>`,
    ].join("\n"),
  };
}

export type LocalizeDecision = { accepted: true; question: Question } | { accepted: false; reason: string };

const NUMBER = /\d+(?:[.,]\d+)*/g;

/**
 * The localizer's gate: non-empty, at most `MAX_LOCALIZED_QUESTION_CHARS`, actually in the target
 * language (Hindi: Devanagari script), every number of the English question kept, and no control-message
 * brackets. On acceptance the question keeps its id, kind, target and value; `text` becomes the
 * translation, `textEnglish` the English it was translated from, `language` the target.
 */
export function acceptLocalized(question: Question, output: LlmLocalizedQuestion, language: ExpertLanguage): LocalizeDecision {
  if (language === "en") return { accepted: false, reason: "English needs no translation" };
  if (question.language !== undefined) return { accepted: false, reason: `already in ${question.language}` };
  const text = output.text.replace(/\s+/g, " ").trim();
  if (text === "") return { accepted: false, reason: "empty translation" };
  if (text.length > MAX_LOCALIZED_QUESTION_CHARS) return { accepted: false, reason: `longer than ${MAX_LOCALIZED_QUESTION_CHARS} characters` };
  if (/[⟦⟧]/.test(text)) return { accepted: false, reason: "contains control-message brackets" };
  const detected = detectLanguage(text);
  if (detected.language !== language || detected.basis !== "devanagari")
    return { accepted: false, reason: `not written in ${EXPERT_LANGUAGE_LABELS[language]} script` };
  const missing = (question.text.match(NUMBER) ?? []).filter((n) => !text.includes(n));
  if (missing.length > 0) return { accepted: false, reason: `dropped number(s) ${missing.join(", ")}` };
  return { accepted: true, question: { ...question, text, textEnglish: question.text, language } };
}
