import { EXPERT_LANGUAGE_LABELS, type ExpertLanguage } from "../schemas/expert";
import type { ExpertQuoteEvidence } from "../schemas/rules";
import type { TranslationSegment } from "../schemas/translation";

/**
 * Original quote + machine translation, deterministically (plan §7.11). The original words are the
 * evidence; the English shown next to them always carries `MACHINE_TRANSLATION_LABEL`.
 */

/** How every surface labels a translation: it is a model product, never the expert's words. */
export const MACHINE_TRANSLATION_LABEL = "English translation (machine, not authoritative)";

/** The same whitespace normalisation as `containsQuote`. */
function norm(s: string): string {
  return s.replace(/\s+/g, " ").trim();
}

const WORD_CHAR = /[\p{L}\p{M}\p{N}]/u;

export type SegmentCheck = { ok: true; spans: [number, number][] } | { ok: false; reason: string };

/**
 * Code-side check of a model's segmentation: every `original` is verbatim in `text` (whitespace
 * normalised, as `containsQuote`), the segments appear in order without overlapping, and together
 * they cover every word — only whitespace and punctuation may lie between or around them, so no part
 * of the expert's words can go untranslated. Spans index the normalised text.
 */
export function checkSegments(text: string, segments: readonly Pick<TranslationSegment, "original">[]): SegmentCheck {
  const whole = norm(text);
  const spans: [number, number][] = [];
  let cursor = 0;
  for (const [i, segment] of segments.entries()) {
    const part = norm(segment.original);
    if (part === "") return { ok: false, reason: `segment ${i} is empty` };
    const at = whole.indexOf(part, cursor);
    if (at < 0) return { ok: false, reason: `segment ${i} is not verbatim in the utterance (after segment ${i - 1})` };
    if (WORD_CHAR.test(whole.slice(cursor, at))) return { ok: false, reason: `words before segment ${i} are not translated` };
    spans.push([at, at + part.length]);
    cursor = at + part.length;
  }
  if (spans.length === 0) return { ok: false, reason: "no segments" };
  if (WORD_CHAR.test(whole.slice(cursor))) return { ok: false, reason: "words after the last segment are not translated" };
  return { ok: true, spans };
}

/**
 * The English rendering of `quote` (a verbatim span of `text`): the English of every verified
 * segment the quote overlaps, joined in order. A quote inside one segment gets that segment's whole
 * English (segments are clause-sized). Undefined when the quote is not in the text or the segments do
 * not verify — never a guess.
 */
export function quoteTranslation(text: string, segments: readonly TranslationSegment[], quote: string): string | undefined {
  const q = norm(quote);
  const at = q === "" ? -1 : norm(text).indexOf(q);
  if (at < 0) return undefined;
  const check = checkSegments(text, segments);
  if (!check.ok) return undefined;
  const english = segments.filter((_, i) => {
    const [start, end] = check.spans[i] ?? [0, 0];
    return start < at + q.length && end > at;
  });
  return english.length === 0 ? undefined : english.map((s) => s.english.trim()).join(" ");
}

/** `Hindi (हिन्दी)`. */
export function languageLabel(language: ExpertLanguage): string {
  return EXPERT_LANGUAGE_LABELS[language];
}

/**
 * The note that goes after a non-English quote in plain-text citations (MCP `check_action`, the
 * tutor): `in Hindi (हिन्दी); English translation (machine, not authoritative): "…"`, or `in Hindi
 * (हिन्दी); no English translation on record` when the translation is pending. Undefined for English.
 */
export function quoteLanguageNote(quote: Pick<ExpertQuoteEvidence, "language" | "translation">): string | undefined {
  if (quote.language === undefined || quote.language === "en") return undefined;
  const lang = `in ${languageLabel(quote.language)}`;
  return quote.translation === undefined ? `${lang}; no English translation on record` : `${lang}; ${MACHINE_TRANSLATION_LABEL}: "${quote.translation}"`;
}
