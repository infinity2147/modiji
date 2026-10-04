import type { ExpertLanguage } from "../schemas/expert";

/**
 * Language of an expert utterance (plan §7.11), decided by code from the transcript text. ElevenLabs'
 * `user_transcript` event carries only the text (`{user_transcript, event_id}`, api-notes §16), so the
 * language is ours to establish. Only the languages an expert may speak are distinguished
 * (`EXPERT_LANGUAGES`: English, Hindi); anything without Hindi evidence is English.
 *
 * Evidence, strongest first:
 * 1. Devanagari script: Scribe writes Hindi speech in Devanagari. When at least
 *    `DEVANAGARI_SHARE` of the letters are Devanagari the utterance is Hindi, whatever the prior —
 *    an English technical term inside a Hindi sentence ("हाई-रिस्क list") does not make it English.
 * 2. Romanised Hindi (Hindi written in Latin letters, "agar country high-risk hai to ..."): a
 *    deliberately conservative list of Hindi function words that are NOT English words
 *    (`ROMANISED_HINDI_MARKERS`; ambiguous ones such as "to", "main", "par", "me", "us" are left out).
 *    Without a Hindi prior it needs at least `ROMANISED_MIN_MARKERS` distinct markers making up at
 *    least `ROMANISED_MIN_SHARE` of the words; with a Hindi prior one marker is enough.
 * 3. Otherwise English.
 *
 * The prior (`prior`) is what the session already knows: the language the browser's voice session
 * was started in, else the expert's declared language. It only lowers the bar for romanised Hindi; it
 * never overrides the text — a Hindi-speaking expert who answers in English is recorded as English.
 */

export const DEVANAGARI_SHARE = 0.2;
export const ROMANISED_MIN_MARKERS = 2;
export const ROMANISED_MIN_SHARE = 0.2;

/** Hindi function words and common verb forms in Latin letters that are not English words. */
export const ROMANISED_HINDI_MARKERS: ReadonlySet<string> = new Set([
  "aap", "agar", "accha", "acha", "aur", "bhi", "chahiye", "hai", "hain", "hoga", "hogi", "honge", "hota", "hoti", "hote",
  "hum", "jab", "jaise", "kabhi", "karna", "karta", "karte", "karti", "kya", "kyon", "kyonki", "kyun", "kyunki", "lekin",
  "matlab", "mein", "mujhe", "nahi", "nahin", "raha", "rahe", "rahi", "sakta", "sakte", "sakti", "sirf", "tab", "theek",
  "toh", "unka", "unki", "uska", "uski", "wala", "wale", "wali", "yeh", "woh",
]);

const LETTER = /\p{L}/gu;
const DEVANAGARI_LETTER = /(?=\p{L})\p{Script=Devanagari}/gu;
const LATIN_WORD = /[a-z]+/g;

export type LanguageBasis = "devanagari" | "romanised_hindi" | "default";
export type DetectedLanguage = { language: ExpertLanguage; basis: LanguageBasis };

export function detectLanguage(text: string, prior: ExpertLanguage = "en"): DetectedLanguage {
  const letters = text.match(LETTER)?.length ?? 0;
  const devanagari = text.match(DEVANAGARI_LETTER)?.length ?? 0;
  if (letters > 0 && devanagari / letters >= DEVANAGARI_SHARE) return { language: "hi", basis: "devanagari" };
  const words = text.toLowerCase().match(LATIN_WORD) ?? [];
  const markers = words.filter((w) => ROMANISED_HINDI_MARKERS.has(w));
  const distinct = new Set(markers).size;
  const romanised =
    prior === "hi" ? distinct >= 1 : distinct >= ROMANISED_MIN_MARKERS && markers.length / Math.max(1, words.length) >= ROMANISED_MIN_SHARE;
  return romanised ? { language: "hi", basis: "romanised_hindi" } : { language: "en", basis: "default" };
}
