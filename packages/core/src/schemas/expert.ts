import { z } from "zod";

/**
 * Who an expert capture session belongs to (plan §7.10) and the language the expert speaks (§7.11).
 * Chosen at session start and recorded in `session.started`; sessions written before P10 carry no
 * expert and belong to `legacyExpertId(sessionId)`, the id the engine always used for them.
 */

/** Languages an expert may speak to the interviewer. Rules are language-neutral; the tutor speaks English. */
export const EXPERT_LANGUAGES = ["en", "hi"] as const;
export const ExpertLanguageSchema = z.enum(EXPERT_LANGUAGES);
export type ExpertLanguage = z.infer<typeof ExpertLanguageSchema>;

export const EXPERT_LANGUAGE_LABELS: Readonly<Record<ExpertLanguage, string>> = { en: "English", hi: "Hindi (हिन्दी)" };

/** A stable expert id: lowercase letters, digits and single hyphens (a slug of the expert's name). */
export const ExpertIdSchema = z
  .string()
  .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/, "must be a slug: lowercase letters and digits separated by single hyphens")
  .max(48);

export const ExpertSchema = z.strictObject({
  id: ExpertIdSchema,
  /** The name the expert typed at session start (display only). */
  name: z.string().trim().min(1).max(60),
  language: ExpertLanguageSchema,
});
export type Expert = z.infer<typeof ExpertSchema>;

/** The expert of a session that predates explicit expert identity (one expert per session). */
export function legacyExpertId(sessionId: string): string {
  return `expert-${sessionId}`;
}

/**
 * The expert id for a typed name: NFKD-folded to ASCII, lowercased, non-alphanumerics collapsed to
 * single hyphens. Undefined when nothing identifying is left (e.g. a name in a script with no ASCII
 * letters — the expert then picks a Latin-script handle).
 */
export function expertIdFromName(name: string): string | undefined {
  const slug = name
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48)
    .replace(/-+$/g, "");
  return ExpertIdSchema.safeParse(slug).success ? slug : undefined;
}
