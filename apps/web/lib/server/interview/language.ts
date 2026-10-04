/**
 * Any-language expert answers (plan §7.11), server side: which language an utterance is in, and the
 * language fields of an expert quote taken from it. Rules stay language-neutral predicates; a quote
 * keeps the expert's original words as evidence and carries its English machine translation (derived
 * deterministically from the utterance's verified translation segments) for display only.
 */
import "server-only";
import { detectLanguage, quoteTranslation, type ExpertLanguage, type ExpertQuoteEvidence } from "@vashistha/core";
import type { UtteranceRecord } from "./engine-state";

/**
 * The language of a transcript, decided by code from its text (`detectLanguage`). Precedence: the
 * text's own evidence (Devanagari script, romanised-Hindi markers) always decides; the prior only lowers
 * the bar for romanised Hindi. The prior is the language the browser's voice session runs in (the
 * optional `language` of the utterance POST: the ASR language it started the conversation with), else
 * the session expert's declared language, else English. Neither can turn an English transcript into
 * Hindi, nor a Devanagari one into English.
 */
export function utteranceLanguage(text: string, prior: { client: ExpertLanguage | undefined; expert: ExpertLanguage | undefined }): ExpertLanguage {
  return detectLanguage(text, prior.client ?? prior.expert ?? "en").language;
}

/** The fields an `ExpertQuoteEvidence` takes from its utterance. Empty for English. */
export type QuoteLanguageFields = Pick<ExpertQuoteEvidence, "language" | "translation">;

/**
 * Language fields for a quote of `utterance` (spread into `ExpertQuoteEvidence`): `{}` for English;
 * otherwise `language` and — when the utterance has a verified translation and `exactQuote` lies in it —
 * `translation`, the English of the segments the quote overlaps. A pending translation leaves
 * `translation` out (never fabricated). `exactQuote` itself is never changed: it is the original words.
 */
export function quoteLanguageFields(utterance: Pick<UtteranceRecord, "text" | "language" | "translation"> | undefined, exactQuote: string): QuoteLanguageFields {
  if (utterance === undefined || utterance.language === "en") return {};
  const translation = utterance.translation && quoteTranslation(utterance.text, utterance.translation.segments, exactQuote);
  return translation === undefined ? { language: utterance.language } : { language: utterance.language, translation };
}
