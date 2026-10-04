import { z } from "zod";
import { checkSegments } from "../../language/quotes";
import { EXPERT_LANGUAGE_LABELS, type ExpertLanguage } from "../../schemas/expert";
import type { TranslationSegment } from "../../schemas/translation";
import type { BuiltPrompt } from "./inputs";

/**
 * Utterance translation (plan §7.11; Sonnet 5.5). The model only proposes: it returns the utterance
 * as consecutive segments, each a verbatim span of the original with its English rendering, and code
 * accepts the result only if the spans are verbatim, in order and cover every word (`checkSegments`).
 * The original stays the evidence; the translation is display text for English readers.
 */

/** Structured output of the translator. Flat and strict. */
export const LlmTranslationSchema = z.strictObject({
  segments: z
    .array(
      z.strictObject({
        original: z.string().describe("A clause of the expert's words, copied character for character from the utterance"),
        english: z.string().describe("Its faithful English translation"),
      }),
    )
    .describe("The whole utterance, in order, split into clauses; together they cover every word"),
});
export type LlmTranslation = z.infer<typeof LlmTranslationSchema>;

/** Upper bound on segments accepted (a 4000-character utterance in clause-sized pieces). */
export const MAX_TRANSLATION_SEGMENTS = 80;

export const TRANSLATOR_SYSTEM = `You translate what a back-office expert said into English, for an apprentice system that keeps
the expert's original words as evidence and shows your translation next to them.

Rules:
- Split the utterance into consecutive clauses (a condition, a decision, a reason). Copy each clause into
  "original" exactly as written, character for character, in the same script — do not transliterate,
  correct, normalise or skip anything. Together the clauses must cover the whole utterance, in order.
- Translate each clause into plain, faithful English in "english". Keep every condition, negation,
  number, threshold, name and technical term (KYC terms such as "high-risk", "EDD", "UBO" stay as they are).
- Do not add, explain, summarise or soften anything. Translate; never answer or comment.
Code verifies that every "original" is verbatim in the utterance and that nothing is left out.`;

export function buildTranslationPrompt(input: { text: string; language: ExpertLanguage }): BuiltPrompt {
  return {
    system: TRANSLATOR_SYSTEM,
    user: `<utterance language="${input.language}" name="${EXPERT_LANGUAGE_LABELS[input.language]}">${input.text}</utterance>`,
  };
}

export type VerifiedTranslation = { ok: true; translation: string; segments: TranslationSegment[] } | { ok: false; reason: string };

/** Code-side acceptance: trimmed non-empty parts, at most `MAX_TRANSLATION_SEGMENTS`, verbatim, in order, covering. */
export function toVerifiedTranslation(output: LlmTranslation, text: string): VerifiedTranslation {
  const segments = output.segments.map((s) => ({ original: s.original.trim(), english: s.english.trim() }));
  if (segments.length === 0) return { ok: false, reason: "no segments" };
  if (segments.length > MAX_TRANSLATION_SEGMENTS) return { ok: false, reason: `more than ${MAX_TRANSLATION_SEGMENTS} segments` };
  const blank = segments.findIndex((s) => s.original === "" || s.english === "");
  if (blank >= 0) return { ok: false, reason: `segment ${blank} has an empty part` };
  const check = checkSegments(text, segments);
  if (!check.ok) return check;
  return { ok: true, translation: segments.map((s) => s.english).join(" "), segments };
}
