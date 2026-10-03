import { z } from "zod";
import { ActionIdSchema, EpochMsSchema, FeatureIdSchema, IdSchema, SchemaVersionSchema, SymbolIdSchema, ValueSchema } from "./primitives";
import { PredicateSchema } from "./predicate";

/** A complete assignment of feature values (a concrete case), e.g. a solver witness or a counterfactual. */
export const AssignmentSchema = z.record(FeatureIdSchema, ValueSchema);
export type Assignment = z.infer<typeof AssignmentSchema>;

/**
 * Solver witnesses (plan §7.5), always within the domain constraints of the current feature model.
 * - unresolved: no terminal decision rule of the family fires.
 * - conflict: two rules of equal priority, neither overriding the other, same family, incompatible
 *   terminal effects on the same assignment (guardrails overriding decisions are not conflicts).
 * - boundary: an assignment at/next to a rule's numeric threshold.
 * - disagreement: two experts' rulebooks decide the family differently (plan §7.10).
 */
const witnessBase = {
  id: IdSchema,
  decisionFamily: SymbolIdSchema,
  assignment: AssignmentSchema,
  schemaVersion: SchemaVersionSchema,
};
export const WitnessSchema = z.discriminatedUnion("kind", [
  z.strictObject({ ...witnessBase, kind: z.literal("unresolved") }),
  z.strictObject({
    ...witnessBase,
    kind: z.literal("conflict"),
    ruleIds: z.tuple([IdSchema, IdSchema]),
    actions: z.tuple([ActionIdSchema, ActionIdSchema]),
  }),
  z.strictObject({
    ...witnessBase,
    kind: z.literal("boundary"),
    ruleId: IdSchema,
    feature: FeatureIdSchema,
    threshold: z.number(),
    side: z.enum(["at", "below", "above"]),
  }),
  z.strictObject({
    ...witnessBase,
    kind: z.literal("disagreement"),
    experts: z.tuple([IdSchema, IdSchema]),
    actions: z.tuple([ActionIdSchema, ActionIdSchema]),
  }),
]);
export type Witness = z.infer<typeof WitnessSchema>;

/** How a gap was resolved by the expert when it is not turned into a rule (plan §7.5 stop criterion). */
export const WitnessResolutionSchema = z.strictObject({
  witnessId: IdSchema,
  resolution: z.enum(["rule_added", "rule_revised", "escalate_to_controller", "out_of_scope"]),
  ledgerEntryId: IdSchema,
});
export type WitnessResolution = z.infer<typeof WitnessResolutionSchema>;

export const QuestionKindSchema = z.enum([
  "why_probe",
  "counterfactual",
  "concept_definition",
  "witness",
  "teach_back",
  "prediction",
  "intervention",
]);
export type QuestionKind = z.infer<typeof QuestionKindSchema>;

/**
 * A question the system may speak. Text is precomputed (≤25 words for live questions, plan §7.2);
 * the gate authorises a question by id and the custom-LLM wrapper speaks exactly this text.
 */
export const QuestionSchema = z.strictObject({
  id: IdSchema,
  sessionId: IdSchema,
  kind: QuestionKindSchema,
  text: z.string().trim().min(1).max(600),
  decisionFamily: SymbolIdSchema.optional(),
  target: z.strictObject({
    caseId: z.string().optional(),
    candidateIds: z.array(IdSchema),
    feature: FeatureIdSchema.optional(),
    witnessId: IdSchema.optional(),
    ruleId: IdSchema.optional(),
    /** For counterfactuals and witnesses: the concrete case the expert is asked about. */
    assignment: AssignmentSchema.optional(),
  }),
  /** Expected information gain in bits (live/debrief questions) or a priority score (interventions). */
  value: z.number().nonnegative(),
  /** Plain-language reason shown on the judge HUD, e.g. "contradiction detected". */
  reason: z.string().min(1),
  /** Ephemeral questions may be asked outside a breakpoint (plan §7.2). */
  ephemeral: z.boolean(),
  createdAt: EpochMsSchema,
  contextVersion: z.int().nonnegative(),
  /** Ledger entries that motivated the question (surprising decision, witness, …). */
  parentIds: z.array(IdSchema),
});
export type Question = z.infer<typeof QuestionSchema>;

/** A rule the expert stated, extracted by the answer parser with the exact quote span. */
export const StatedRuleSchema = z.strictObject({
  predicate: PredicateSchema,
  action: ActionIdSchema,
  kind: z.enum(["decision", "guardrail", "escalation", "exception"]),
  exactQuote: z.string().trim().min(1),
  t0Ms: z.int().nonnegative(),
  t1Ms: z.int().nonnegative(),
});
export type StatedRule = z.infer<typeof StatedRuleSchema>;

/** A concept the expert used that the feature model does not have yet (plan §6.6). */
export const ProposedConceptSchema = z.strictObject({
  name: SymbolIdSchema,
  label: z.string().min(1),
  definition: z.string().min(1),
  type: z.enum(["boolean", "number", "enum"]),
  values: z.array(z.string().min(1)).optional(),
  exactQuote: z.string().trim().min(1).optional(),
});
export type ProposedConcept = z.infer<typeof ProposedConceptSchema>;

/**
 * Structured reading of an expert answer (Sonnet, constrained schema). The parser only proposes;
 * code validates predicates against the domain and decides what is promoted.
 */
export const ParsedAnswerSchema = z.strictObject({
  questionId: IdSchema,
  utteranceId: IdSchema,
  survivingCandidateIds: z.array(IdSchema),
  eliminatedCandidateIds: z.array(IdSchema),
  statedRules: z.array(StatedRuleSchema),
  newConcepts: z.array(ProposedConceptSchema),
  /** For counterfactual/witness questions: the action the expert says applies to the asked case. */
  answeredAction: ActionIdSchema.optional(),
  confidence: z.number().min(0).max(1),
});
export type ParsedAnswer = z.infer<typeof ParsedAnswerSchema>;

/** Transparent mastery ladder (plan §7.7). */
export const MASTERY_LEVELS = ["untested", "assisted", "independent_once", "boundary_correct", "mastered"] as const;
export const MasteryLevelSchema = z.enum(MASTERY_LEVELS);
export type MasteryLevel = z.infer<typeof MasteryLevelSchema>;
