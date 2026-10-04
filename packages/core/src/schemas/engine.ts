import { z } from "zod";
import { ActionIdSchema, EpochMsSchema, FeatureIdSchema, IdSchema, SchemaVersionSchema, SymbolIdSchema, ValueSchema } from "./primitives";
import { ExpertLanguageSchema } from "./expert";
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
  /** A turn of the debrief conversation (plan §7.5 as a dialogue), spoken only by the debrief page's voice loop. */
  "debrief_turn",
  "prediction",
  "intervention",
  /**
   * A turn of the trainee's voice coach: a reply to what the trainee just said, or a nudge the tutor raised
   * itself (a case opened, a selection off the expert's rules, a decision saved). Spoken by the tutor only.
   */
  "coach_turn",
]);
export type QuestionKind = z.infer<typeof QuestionKindSchema>;

/**
 * The live interview's own questions (plan §7.2–7.3), asked while the expert works: the only kinds the
 * interview queue plans and supersedes, and the only kinds the live budget counts. Debrief (`witness`,
 * `teach_back`, `debrief_turn`) and tutor (`prediction`, `intervention`) questions belong to their own flows.
 */
export const LIVE_QUESTION_KINDS = ["why_probe", "counterfactual", "concept_definition"] as const satisfies readonly QuestionKind[];

export function isLiveQuestionKind(kind: QuestionKind): boolean {
  return (LIVE_QUESTION_KINDS as readonly QuestionKind[]).includes(kind);
}

/**
 * A question the system may speak. Text is precomputed (≤25 words for live questions, plan §7.2);
 * the gate authorises a question by id and the custom-LLM wrapper speaks exactly this text.
 */
export const QuestionSchema = z.strictObject({
  id: IdSchema,
  sessionId: IdSchema,
  kind: QuestionKindSchema,
  text: z.string().trim().min(1).max(600),
  /**
   * P10: when `text` is rendered in the expert's language (a model translation of the precomputed
   * English question), the English original it was translated from. The gate still authorises, and
   * the agent still speaks, exactly `text`.
   */
  textEnglish: z.string().trim().min(1).max(600).optional(),
  language: ExpertLanguageSchema.optional(),
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

/** Who may sign off a `require_approval` stop-rule the expert states (a fixed list: the parser picks, code checks). */
export const APPROVAL_ROLES = ["compliance_officer", "senior_reviewer", "controller"] as const;
export const ApprovalRoleSchema = z.enum(APPROVAL_ROLES);
export type ApprovalRole = z.infer<typeof ApprovalRoleSchema>;

/**
 * What a stated rule enforces: the subset of `RuleEffect` an expert states in words. `forbid` and
 * `require_approval` are stop-rules ("never approve …", "needs compliance sign-off"); `recommend` is
 * a decision ("… goes to enhanced review").
 */
export const StatedRuleEffectSchema = z.discriminatedUnion("type", [
  z.strictObject({ type: z.literal("recommend"), action: ActionIdSchema }),
  z.strictObject({ type: z.literal("forbid"), action: ActionIdSchema }),
  // `action` is the action whose sign-off is required (live bug #4); optional for backwards compatibility
  // with rules stated before it was recorded, which gate the whole decision family.
  z.strictObject({ type: z.literal("require_approval"), role: ApprovalRoleSchema, action: ActionIdSchema.optional() }),
]);
export type StatedRuleEffect = z.infer<typeof StatedRuleEffectSchema>;

export function isStopEffect(effect: Pick<StatedRuleEffect, "type">): boolean {
  return effect.type === "forbid" || effect.type === "require_approval";
}

/**
 * A rule the expert stated, extracted by the answer parser (or typed in the debrief) with the exact
 * quote span. Coherence, enforced here:
 *   - `action` is the family action the rule is about: the recommended action, the forbidden action,
 *     or the action that needs sign-off — so for `recommend`/`forbid` it equals `effect.action`;
 *   - `kind` is "guardrail" exactly when the effect is a stop-rule (`forbid` / `require_approval`).
 * Backwards compatibility: entries written before `effect` existed carry none. For decisions,
 * exceptions and escalations the effect was always "recommend `action`", so that default is filled
 * in; a legacy guardrail is ambiguous (its polarity was never recorded) and fails validation.
 */
export const StatedRuleSchema = z
  .strictObject({
    predicate: PredicateSchema,
    action: ActionIdSchema,
    kind: z.enum(["decision", "guardrail", "escalation", "exception"]),
    effect: StatedRuleEffectSchema.optional(),
    exactQuote: z.string().trim().min(1),
    t0Ms: z.int().nonnegative(),
    t1Ms: z.int().nonnegative(),
    /**
     * An answer given in several transcript segments: the segment the quote is verbatim in (its span is
     * `t0Ms`–`t1Ms`). Absent: the answer's own `utteranceId`.
     */
    utteranceId: IdSchema.optional(),
  })
  .transform((rule, ctx) => {
    const effect: StatedRuleEffect | undefined = rule.effect ?? (rule.kind === "guardrail" ? undefined : { type: "recommend", action: rule.action });
    if (effect === undefined) {
      ctx.addIssue({ code: "custom", path: ["effect"], message: "a stated guardrail must say what it enforces (forbid or require_approval)" });
      return z.NEVER;
    }
    // Every effect that names an action must name the rule's action (a `require_approval` without one
    // gates the whole family and is exempt).
    if (effect.action !== undefined && effect.action !== rule.action)
      ctx.addIssue({ code: "custom", path: ["effect", "action"], message: `effect action "${effect.action}" differs from the rule's action "${rule.action}"` });
    if (isStopEffect(effect) !== (rule.kind === "guardrail"))
      ctx.addIssue({ code: "custom", path: ["kind"], message: `a ${effect.type} rule must ${isStopEffect(effect) ? "" : "not "}be a guardrail` });
    return { ...rule, effect };
  });
export type StatedRule = z.output<typeof StatedRuleSchema>;

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
  /** The answer's (first) transcript segment. */
  utteranceId: IdSchema,
  /**
   * Every transcript segment of the answer in order, `utteranceId` first, when the provider split it
   * into several (absent: one segment). Each stays its own `utterance.transcript` evidence entry.
   */
  segmentIds: z.array(IdSchema).min(2).optional(),
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
