/**
 * HTTP contract for undefined concepts and schema versioning (plan §6.6, §7.5). Browser-safe. Models
 * propose concepts; the expert confirms (with their own definition and words) or dismisses them; the
 * server versions the feature model, re-reads past cases from stored redacted frames and recomputes.
 */
import { z } from "zod";
import { BackfillFailureSchema, FeatureIdSchema, IdSchema, SymbolIdSchema, ValueSchema } from "@vashistha/core";

const ExpertTextSchema = z.string().trim().min(1).max(1000);

/** The expert's own words: typed, or (with `utteranceId`) a verbatim span of a recorded utterance. */
export const ExpertWordsInputSchema = z.strictObject({ text: ExpertTextSchema, utteranceId: IdSchema.optional() });

/** The definition the expert confirms; the concept id stays the proposed name. */
export const ConceptDefinitionInputSchema = z.discriminatedUnion("type", [
  z.strictObject({ type: z.literal("boolean"), label: z.string().trim().min(1).max(80), description: z.string().trim().min(1).max(400).optional() }),
  z.strictObject({
    type: z.literal("enum"),
    label: z.string().trim().min(1).max(80),
    description: z.string().trim().min(1).max(400).optional(),
    values: z.array(z.string().trim().min(1).max(60)).min(2).max(12),
  }),
  z.strictObject({
    type: z.literal("number"),
    label: z.string().trim().min(1).max(80),
    description: z.string().trim().min(1).max(400).optional(),
    min: z.number(),
    max: z.number(),
    integer: z.boolean(),
    unit: z.string().trim().min(1).max(20).optional(),
  }),
]);

/** POST /api/sessions/:sessionId/concepts */
export const ConceptActionRequestSchema = z.discriminatedUnion("action", [
  z.strictObject({ action: z.literal("confirm"), name: SymbolIdSchema, definition: ConceptDefinitionInputSchema, statement: ExpertWordsInputSchema }),
  z.strictObject({
    action: z.literal("dismiss"),
    name: SymbolIdSchema,
    reason: z.enum(["not_a_concept", "already_covered"]),
    coveredBy: FeatureIdSchema.optional(),
    statement: ExpertWordsInputSchema,
  }),
]);
export type ConceptActionRequest = z.infer<typeof ConceptActionRequestSchema>;

export const ConceptActionResponseSchema = z.strictObject({
  /** The `concept.confirmed` / `concept.dismissed` entry. */
  entryId: IdSchema,
  /** The `schema.version_bumped` entry (confirm only). */
  bumpEntryId: IdSchema.nullable(),
  schemaVersion: z.int().min(1),
  /** Decisions whose value is being re-read in the background (confirm only). */
  backfillQueued: z.int().nonnegative(),
});

const UndefinedConceptViewSchema = z.strictObject({
  name: SymbolIdSchema,
  label: z.string(),
  definition: z.string(),
  type: z.enum(["boolean", "number", "enum"]),
  values: z.array(z.string()),
  /** The expert's words the proposer quoted (interview), or null (vision proposals). */
  quote: z.string().nullable(),
  origin: z.enum(["interview", "answer", "vision"]),
  proposalEntryIds: z.array(IdSchema),
});

const BackfillViewSchema = z.strictObject({
  decisionEntryId: IdSchema,
  caseId: z.string(),
  /** Null while the re-read is pending. */
  entryId: IdSchema.nullable(),
  value: ValueSchema.nullable(),
  failure: BackfillFailureSchema.nullable(),
  frameIds: z.array(IdSchema),
});

const ConfirmedConceptViewSchema = z.strictObject({
  name: SymbolIdSchema,
  label: z.string(),
  type: z.enum(["boolean", "number", "enum"]),
  schemaVersion: z.int().min(1),
  entryId: IdSchema,
  bumpEntryId: IdSchema.nullable(),
  statement: z.string(),
  backfill: z.array(BackfillViewSchema),
});

/** GET /api/sessions/:sessionId/concepts */
export const ConceptsStateSchema = z.strictObject({
  sessionId: IdSchema,
  schemaVersion: z.int().min(1),
  baseSchemaVersion: z.int().min(1),
  /** Backfill re-reads pending or running: coverage under the new model is not final yet. */
  recomputing: z.boolean(),
  /** The latest confirmation, for the "Model updated" banner. */
  latest: z.strictObject({ name: SymbolIdSchema, label: z.string(), schemaVersion: z.int().min(1) }).nullable(),
  undefinedConcepts: z.array(UndefinedConceptViewSchema),
  confirmed: z.array(ConfirmedConceptViewSchema),
  dismissed: z.array(z.strictObject({ name: SymbolIdSchema, reason: z.enum(["not_a_concept", "already_covered"]), coveredBy: FeatureIdSchema.nullable(), entryId: IdSchema })),
  /** Features of the current model (for "already covered by …"). */
  features: z.array(z.strictObject({ id: FeatureIdSchema, label: z.string() })),
  /** A vision model is configured: backfill can re-read frames (otherwise every value is Unknown{backfill_failed}). */
  rereadAvailable: z.boolean(),
});
export type ConceptsState = z.infer<typeof ConceptsStateSchema>;
