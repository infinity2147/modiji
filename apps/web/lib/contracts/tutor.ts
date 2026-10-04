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

/**
 * One turn of the trainee's conversation with the voice coach, for live captions. A trainee turn is what they said
 * (a final transcript, original words) or typed (`/tutor/chat`); a coach turn is what the coach says or said: a
 * reply or nudge (`coach_turn`), the welcome briefing, or a stop-rule warning. `spoken`: the gate authorized it
 * (a coach turn), or it reached the coach by voice (a trainee turn); a typed turn and a reply not yet voiced are not.
 */
export const CoachTurnViewSchema = z.strictObject({
  /** The ledger entry (trainee) or the question id (coach). */
  id: z.string().min(1),
  role: z.enum(["trainee", "coach"]),
  text: z.string().min(1),
  at: z.number(),
  caseId: z.string().nullable(),
  /** Why the coach spoke: reply, case_opened, off_track, prediction, committed, idle, stuck, briefing, intervention; null for a trainee turn. */
  trigger: z.string().nullable(),
  spoken: z.boolean(),
});
export type CoachTurnView = z.infer<typeof CoachTurnViewSchema>;

/** GET /api/sessions/:sessionId/tutor (novice sessions). */
export const TutorStateSchema = z.strictObject({
  sessionId: IdSchema,
  rulebookRevision: z.int().nonnegative(),
  masteryLabel: z.literal(MASTERY_LABEL),
  rules: z.array(TutorRuleSchema),
  cases: z.array(CaseTutorViewSchema),
  /** The latest turns of the coach conversation (oldest first, at most 20). */
  coach: z.array(CoachTurnViewSchema),
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

/**
 * POST /api/sessions/:sessionId/tutor/briefing — the trainee turned on the voice coach: queue its spoken welcome
 * (once per session). `queued: false` says why nothing was queued: no confirmed rules to teach, or already given.
 */
export const BriefingRequestSchema = z.strictObject({ caseId: z.string().min(1).optional() });
export const BriefingResponseSchema = z.discriminatedUnion("queued", [
  z.strictObject({ queued: z.literal(true), text: z.string() }),
  z.strictObject({ queued: z.literal(false), reason: z.enum(["no_rules", "already_given"]) }),
]);

/**
 * POST /api/sessions/:sessionId/tutor/chat — the trainee types to the coach (no microphone needed). The same
 * conversation as speech: the reply is grounded in the confirmed rulebook and the trainee's current case, queued
 * for speech when the voice coach is on (`questionId`), and returned as text so the UI can show it either way.
 * `questionId` is null when nothing was queued (a newer message from the trainee superseded this reply).
 */
export const CoachChatRequestSchema = z.strictObject({ text: z.string().trim().min(1).max(1000) });
export const CoachChatResponseSchema = z.strictObject({ questionId: IdSchema.nullable(), text: z.string() });

/**
 * POST /api/sessions/:sessionId/tutor/nudge — the trainee has been quiet on an open, undecided case (`idle`: the
 * client calls after ~45 s with no activity; `stuck`: a stronger hint, the expert's rule itself). Queues one spoken
 * hint from the confirmed rulebook, once per case per reason. `queued: false` says why not: the case is decided, the
 * hint was already given, or the rules have nothing to say about the case.
 */
export const CoachNudgeRequestSchema = z.strictObject({ caseId: z.string().min(1), reason: z.enum(["idle", "stuck"]) });
export const CoachNudgeResponseSchema = z.discriminatedUnion("queued", [
  z.strictObject({ queued: z.literal(true), questionId: IdSchema, text: z.string() }),
  z.strictObject({ queued: z.literal(false), reason: z.enum(["decided", "already_given", "nothing_to_say"]) }),
]);
