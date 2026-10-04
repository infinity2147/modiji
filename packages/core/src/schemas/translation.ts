import { z } from "zod";
import { ExpertLanguageSchema } from "./expert";
import { IdSchema } from "./primitives";

/**
 * Machine translation of an expert utterance (plan §7.11). The expert's ORIGINAL words are the
 * evidence; a translation is a model product shown for reading only — never authoritative, never
 * parsed back into a rule. It is stored as segments whose `original` parts were verified by code to
 * be verbatim spans of the utterance, in order and covering it, so the English rendering of any
 * quote can be derived deterministically from the segments that overlap it.
 */
export const TranslationSegmentSchema = z.strictObject({
  /** A verbatim span of the original utterance. */
  original: z.string().trim().min(1),
  /** Its English rendering (machine translation). */
  english: z.string().trim().min(1),
});
export type TranslationSegment = z.infer<typeof TranslationSegmentSchema>;

/** Payload of `utterance.translated` (source `engine`, parent: the `utterance.transcript` entry). */
export const UtteranceTranslatedPayloadSchema = z
  .strictObject({
    utteranceId: IdSchema,
    /** The utterance's language (never English: English needs no translation). */
    language: ExpertLanguageSchema,
    /** The whole utterance in English: the segments' English parts, joined. */
    translation: z.string().trim().min(1),
    segments: z.array(TranslationSegmentSchema).min(1),
    /** The model that translated (provenance). */
    model: z.string().min(1),
  })
  .refine((p) => p.language !== "en", { message: "English utterances are not translated", path: ["language"] });
export type UtteranceTranslatedPayload = z.infer<typeof UtteranceTranslatedPayloadSchema>;
