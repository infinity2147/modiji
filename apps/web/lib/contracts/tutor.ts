/**
 * HTTP contract of the tutor (P6, plan §7.7) between the novice CaseDesk UI and the server.
 * Browser-safe: no oracle, no server modules. Every expected outcome, warning and mastery level here
 * is computed by code from the expert's confirmed rulebook; quotes are the expert's exact words.
 */
import { z } from "zod";
import { ActionIdSchema, ExpertLanguageSchema, GuardrailResultSchema, IdSchema, MasteryLevelSchema, RuleKindSchema } from "@vashistha/core";
import { KycCaseSchema } from "@vashistha/core/domains/kyc";
import { ReviewEditsSchema } from "./casedesk";

/** The mastery ladder is a transparent rule of thumb, not a calibrated model (plan §7.7). */
export const MASTERY_LABEL = "heuristic estimate";

/** The expert's moment behind a quote (`replay_moment`): what was on their screen when they said it. */
export const ReplayMomentSchema = z.strictObject({
  /** Redacted frame of the expert's screen (perception), or null when none was captured. */
  frameUrl: z.string().nullable(),
  /** Why there is no frame, said plainly; null when there is one. */
  frameNote: z.string().nullable(),
  /** What the DOM channel recorded on the expert's screen at that moment, one line per event. */
  screen: z.array(z.string()),
  /** Why audio playback is unavailable (conversation audio is not stored by this system). */
  audioNote: z.string(),
});
export type ReplayMoment = z.infer<typeof ReplayMomentSchema>;

export const ExpertQuoteViewSchema = z.strictObject({
  /** Verbatim: the expert's original words, in the language they spoke. */
  text: z.string().min(1),
  /** The language of `text` when it is not English (plan §7.11; absent = English). */
  language: ExpertLanguageSchema.optional(),
  /** Its English machine translation (not authoritative), when one is on record. */
  translation: z.string().min(1).optional(),
  /** "The expert, by voice" / "The expert, typed during the debrief". */
  attribution: z.string().min(1),
  replay: ReplayMomentSchema,
});
export type ExpertQuoteView = z.infer<typeof ExpertQuoteViewSchema>;

/** A confirmed rule as the tutor teaches it, with the novice's place on the ladder. */
export const TutorRuleSchema = z.strictObject({
  ruleId: IdSchema,
  kind: RuleKindSchema,
  when: z.string(),
  then: z.string(),
  /** A stop-rule: it forbids an outcome (the Save interlock blocks it; the tutor intervenes). */
  stopRule: z.boolean(),
  quote: ExpertQuoteViewSchema,
  level: MasteryLevelSchema,
});
export type TutorRule = z.infer<typeof TutorRuleSchema>;

export const PredictionViewSchema = z.strictObject({
  entryId: IdSchema,
  predicted: ActionIdSchema,
  expected: ActionIdSchema,
  correct: z.boolean(),
  /** The confirmed rules that decide the expected outcome. */
  ruleIds: z.array(IdSchema),
});
export type PredictionView = z.infer<typeof PredictionViewSchema>;

export const InterventionTriggerSchema = z.enum(["guardrail_violation", "insufficient_information"]);

export const InterventionViewSchema = z.strictObject({
  entryId: IdSchema,
  caseId: z.string(),
  trigger: InterventionTriggerSchema,
  proposedAction: ActionIdSchema,
  ruleIds: z.array(IdSchema),
  questionId: IdSchema,
  /** Exactly what the tutor agent speaks (precomputed from the rule and the expert's quote). */
  text: z.string().min(1),
  /** The spoken intervention: queued for immediate speech, spoken (gate authorized), or dropped (outcome changed first). */
  speech: z.enum(["queued", "spoken", "dropped"]),
});
export type InterventionView = z.infer<typeof InterventionViewSchema>;

export const PromptSchema = z.discriminatedUnion("ask", [
  /** Ask "What would the expert decide?" before the novice decides. */
  z.strictObject({ ask: z.literal(true) }),
  z.strictObject({ ask: z.literal(false), reason: z.string().min(1) }),
]);
export type Prompt = z.infer<typeof PromptSchema>;

/** Where a case of the session came from: the case set, a solver practice case (boundary or contrast), or a judge. */
export const CaseOriginSchema = z.enum(["case_set", "boundary_practice", "contrast_practice", "judge"]);

export const CaseTutorViewSchema = z.strictObject({
  caseId: z.string(),
  origin: CaseOriginSchema,
  prompt: PromptSchema,
  prediction: PredictionViewSchema.nullable(),
  interventions: z.array(InterventionViewSchema),
});
export type CaseTutorView = z.infer<typeof CaseTutorViewSchema>;

/** GET /api/sessions/:sessionId/tutor (novice sessions). */
export const TutorStateSchema = z.strictObject({
  sessionId: IdSchema,
  rulebookRevision: z.int().nonnegative(),
  masteryLabel: z.literal(MASTERY_LABEL),
  rules: z.array(TutorRuleSchema),
  cases: z.array(CaseTutorViewSchema),
});
export type TutorState = z.infer<typeof TutorStateSchema>;

/**
 * POST /api/sessions/:sessionId/tutor/intent — the novice selected an outcome (DOM channel, not yet
 * saved). The guardrail monitor runs `checkAction` over the confirmed rulebook; a stop-rule violation
 * (or missing information on one) is recorded as `tutor.intervention` and queued for immediate speech.
 */
export const TutorIntentRequestSchema = z.strictObject({
  caseId: z.string().min(1),
  proposedAction: ActionIdSchema,
  edits: ReviewEditsSchema,
});
export const TutorIntentResponseSchema = z.strictObject({
  result: GuardrailResultSchema,
  /** The warning for this selection (recorded now, or earlier for the same case, action and rules), or null. */
  intervention: InterventionViewSchema.nullable(),
  /** A new intervention was recorded and queued now (false: none, or already given). */
  fresh: z.boolean(),
});

/** POST /api/sessions/:sessionId/tutor/prediction — "What would the expert decide?" */
export const PredictionRequestSchema = z.strictObject({
  caseId: z.string().min(1),
  predicted: ActionIdSchema,
  edits: ReviewEditsSchema,
});
export const PredictionResponseSchema = z.strictObject({ prediction: PredictionViewSchema, state: TutorStateSchema });

/** POST /api/sessions/:sessionId/tutor/practice — unseen boundary and contrast cases for the weakest rules. */
export const PracticeResponseSchema = z.strictObject({
  cases: z.array(KycCaseSchema),
  /** Why fewer cases than asked for were made, if so. */
  note: z.string().nullable(),
  state: TutorStateSchema,
});

/** Decision-feature values of a judge-entered case (the domain re-validates every value). */
export const JudgeFeaturesSchema = z.strictObject({
  entityType: z.enum(["individual", "company", "trust"]),
  customerStatus: z.enum(["new", "existing"]),
  accountAgeMonths: z.int().min(0).max(600),
  jurisdictionRisk: z.enum(["low", "medium", "high"]),
  uboOwnershipPct: z.number().gt(0).max(100),
  uboVerified: z.boolean(),
  pep: z.boolean(),
  sanctionsHit: z.boolean(),
  adverseMedia: z.boolean(),
  sourceOfFunds: z.enum(["verified", "unverified", "not_provided"]),
  expectedMonthlyVolume: z.int().min(0).max(10_000_000),
});
export type JudgeFeatures = z.infer<typeof JudgeFeaturesSchema>;

/** POST /api/sessions/:sessionId/tutor/cases — a judge enters an unseen case of their own. */
export const JudgeCaseRequestSchema = z.strictObject({ features: JudgeFeaturesSchema });
export const JudgeCaseResponseSchema = z.strictObject({ case: KycCaseSchema, state: TutorStateSchema });
