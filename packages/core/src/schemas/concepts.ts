import { z } from "zod";
import { FeatureIdSchema, IdSchema, SchemaVersionSchema, SymbolIdSchema, UnknownSchema, ValueSchema } from "./primitives";

/**
 * Schema versioning payloads (plan §6.6). A concept proposed by a model becomes a feature only through
 * the expert's confirmation, which carries the expert's own definition and words.
 */

const definitionBase = {
  name: FeatureIdSchema,
  label: z.string().trim().min(1).max(80),
  description: z.string().trim().min(1).max(400).optional(),
};

/** A concept as the expert defined it when confirming. Enum concepts need two values; numbers need bounds. */
export const ConceptDefinitionSchema = z.discriminatedUnion("type", [
  z.strictObject({ ...definitionBase, type: z.literal("boolean") }),
  z.strictObject({ ...definitionBase, type: z.literal("enum"), values: z.array(z.string().trim().min(1).max(60)).min(2).max(12) }),
  z.strictObject({
    ...definitionBase,
    type: z.literal("number"),
    min: z.number(),
    max: z.number(),
    integer: z.boolean(),
    unit: z.string().trim().min(1).max(20).optional(),
  }),
]);
export type ConceptDefinition = z.infer<typeof ConceptDefinitionSchema>;

/**
 * The expert's own words behind a confirmation or dismissal: typed in the UI (`human_text`, the entry is
 * written by `expert`) or a verbatim span of a recorded utterance (`human_voice`, `utteranceId` set and a
 * parent of the entry).
 */
export const ExpertWordsSchema = z.strictObject({
  text: z.string().trim().min(1).max(1000),
  provenance: z.enum(["human_text", "human_voice"]),
  utteranceId: IdSchema.optional(),
});
export type ExpertWords = z.infer<typeof ExpertWordsSchema>;

export const ConceptConfirmedPayloadSchema = z.strictObject({
  feature: FeatureIdSchema,
  /** The schema version this confirmation introduces. */
  schemaVersion: SchemaVersionSchema,
  definition: ConceptDefinitionSchema,
  statement: ExpertWordsSchema,
});

export const ConceptDismissedPayloadSchema = z
  .strictObject({
    name: SymbolIdSchema,
    reason: z.enum(["not_a_concept", "already_covered"]),
    /** For `already_covered`: the existing feature that captures it. */
    coveredBy: FeatureIdSchema.optional(),
    statement: ExpertWordsSchema,
  })
  .refine((p) => (p.reason === "already_covered") === (p.coveredBy !== undefined), { message: "coveredBy is set exactly when reason is already_covered" });

export const SchemaVersionBumpedPayloadSchema = z
  .strictObject({ from: SchemaVersionSchema, to: SchemaVersionSchema, feature: FeatureIdSchema, label: z.string().min(1) })
  .refine((p) => p.to === p.from + 1, { message: "a bump adds exactly one version" });

/** Why a backfill produced no value. Every one of them maps to `Unknown{backfill_failed}`. */
export const BackfillFailureSchema = z.enum([
  /** No model configured (no ANTHROPIC_API_KEY): nothing was read. */
  "no_model",
  /** No redacted frame was recorded while the case was open. */
  "no_frames",
  /** Frames are in the ledger but their stored images are gone. */
  "frames_missing",
  /** The model looked and reported the concept as not visible. */
  "not_visible",
  /** The model's value does not fit the feature's type or bounds. */
  "invalid_value",
  /** The model call failed (error, refusal, deadline). */
  "model_error",
]);
export type BackfillFailure = z.infer<typeof BackfillFailureSchema>;

const BackfillUnknownSchema = UnknownSchema.extend({ reason: z.literal("backfill_failed") });

export const FeatureBackfilledPayloadSchema = z
  .strictObject({
    feature: FeatureIdSchema,
    schemaVersion: SchemaVersionSchema,
    /** The `case.decision` entry whose case the value belongs to. */
    decisionEntryId: IdSchema,
    caseId: z.string().min(1),
    value: z.union([ValueSchema, BackfillUnknownSchema]),
    /** Set exactly when `value` is unknown. */
    failure: BackfillFailureSchema.optional(),
    /** The model's description of where it saw the value (never used as a value). */
    evidence: z.string().max(400).optional(),
    /** `frame.received` entries whose stored redacted images were re-read (also parents of the entry). */
    frameIds: z.array(IdSchema),
    /** "after_confirmation": a decision taken before the concept existed; "new_case": one taken after. */
    timing: z.enum(["after_confirmation", "new_case"]),
  })
  .refine((p) => (typeof p.value === "object") === (p.failure !== undefined), { message: "failure is set exactly when the value is unknown" });
