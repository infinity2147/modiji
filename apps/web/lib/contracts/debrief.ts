/**
 * HTTP contract of the debrief, Work Map and lineage views (P5, plan §7.5–7.6). Browser-safe: no
 * oracle, no server modules. Every number and status here is computed by code from the ledger and the
 * confirmed rulebook; the only model-written text is marked by an `origin` of "llm".
 */
import { z } from "zod";
import {
  ActionIdSchema,
  ApprovalRoleSchema,
  ConfirmedRuleSchema,
  CoverageSchema,
  ExpertLanguageSchema,
  IdSchema,
  LedgerSourceSchema,
  LlmConditionSchema,
  PredicateSchema,
  WitnessResolutionSchema,
  WitnessSchema,
  WorkMapSchema,
} from "@vashistha/core";

/** The expert's own words, typed when voice is not used; they become evidence (`human_text`). */
export const ExpertQuoteSchema = z.string().trim().min(3).max(1000);

export const ProseOriginSchema = z.enum(["llm", "template"]);

export const WitnessStatusSchema = z.enum([
  /** Found by the solver now; no debrief question yet. */
  "open",
  /** Its debrief question is queued for the interviewer. */
  "queued",
  /** The interviewer asked it; no resolving answer yet. */
  "asked",
  /** Closed by a rule added or revised (the solver no longer finds it). */
  "resolved",
  /** The expert marked it "escalate to controller" or out of scope. */
  "acknowledged",
  /** Boundary check: the expert confirmed the rule's behaviour at the threshold. */
  "confirmed",
  /** No longer found under the current rulebook without an explicit resolution. */
  "superseded",
]);
export type WitnessStatus = z.infer<typeof WitnessStatusSchema>;

export const WitnessViewSchema = z.strictObject({
  witness: WitnessSchema,
  status: WitnessStatusSchema,
  /** Found by the solver under the current rulebook. */
  current: z.boolean(),
  /** The `witness.found` entry (null until recorded by a rebuild). */
  foundEntryId: IdSchema.nullable(),
  question: z.strictObject({ id: IdSchema, text: z.string(), entryId: IdSchema }).nullable(),
  resolution: WitnessResolutionSchema.nullable(),
  /** The case in plain language, one phrase per feature that matters to the rulebook. */
  conditions: z.array(z.string()),
  /** For unresolved witnesses: the rule the expert would confirm for this decision cell. */
  cellRule: z.strictObject({ predicate: PredicateSchema, text: z.string() }).nullable(),
  /** The action the hypotheses predict for the case (a suggestion only). */
  suggestedAction: ActionIdSchema.nullable(),
});
export type WitnessView = z.infer<typeof WitnessViewSchema>;

export const GapSchema = z.strictObject({
  source: z.enum(["live_question", "unexplained_decision", "undefined_concept", "witness"]),
  id: z.string().min(1),
  text: z.string().min(1),
  /** Ledger entry behind the gap, for its trace. */
  ledgerEntryId: IdSchema.nullable(),
});

export const ProposalSchema = z.strictObject({
  candidateId: IdSchema,
  decisionFamily: z.string(),
  action: ActionIdSchema,
  predicate: PredicateSchema,
  text: z.string(),
  origin: z.enum(["enumerated", "llm", "expert_statement"]),
  weight: z.number(),
});

export const RuleViewSchema = z.strictObject({
  rule: ConfirmedRuleSchema,
  when: z.string(),
  then: z.string(),
  /** Latest `rule.confirmed` / `rule.revised` entry of this rule, for its trace. */
  entryId: IdSchema,
  /** Observed decisions of this session the rule explains. */
  explains: z.int().nonnegative(),
});
export type RuleView = z.infer<typeof RuleViewSchema>;

export const RuleChangeSchema = z.strictObject({
  rulebookRevision: z.int().nonnegative(),
  kind: z.enum(["confirmed", "revised", "retired"]),
  ruleId: IdSchema,
  ledgerEntryId: IdSchema,
  fields: z.array(z.string()),
  before: z.strictObject({ when: z.string(), then: z.string(), priority: z.int(), overrides: z.array(IdSchema) }).nullable(),
  after: z.strictObject({ when: z.string(), then: z.string(), priority: z.int(), overrides: z.array(IdSchema) }).nullable(),
  reason: z.string().nullable(),
});
export type RuleChange = z.infer<typeof RuleChangeSchema>;

export const TeachBackViewSchema = z.strictObject({
  entryId: IdSchema,
  text: z.string(),
  origin: ProseOriginSchema,
  rulebookRevision: z.int().nonnegative(),
  ruleIds: z.array(IdSchema),
  /** Written for the rulebook in force now. */
  current: z.boolean(),
  confirmedEntryId: IdSchema.nullable(),
  questionId: IdSchema.nullable(),
});

export const DecisionViewSchema = z.strictObject({
  entryId: IdSchema,
  caseId: z.string(),
  action: ActionIdSchema,
  actionLabel: z.string(),
  explained: z.boolean(),
  ruleIds: z.array(IdSchema),
});

/** GET /api/sessions/:sessionId/debrief (also the body of every debrief POST). */
export const DebriefStateSchema = z.strictObject({
  sessionId: IdSchema,
  rulebookRevision: z.int().nonnegative(),
  coverage: CoverageSchema,
  decisions: z.array(DecisionViewSchema),
  gaps: z.array(GapSchema),
  witnesses: z.array(WitnessViewSchema),
  proposals: z.array(ProposalSchema),
  rules: z.array(RuleViewSchema),
  lastChange: RuleChangeSchema.nullable(),
  teachBack: TeachBackViewSchema.nullable(),
  /** Debrief questions queued from witnesses in this session (≥3 is the P5 acceptance bar). */
  debriefQuestions: z.int().nonnegative(),
  /** Witness questions whose witness is closed (resolved, acknowledged, confirmed) / all witness questions. */
  gapsClosed: z.strictObject({ closed: z.int().nonnegative(), total: z.int().nonnegative() }),
  /** Expert answers to debrief questions received by voice and not yet applied (applied by a witness rebuild). */
  pendingVoiceAnswers: z.int().nonnegative(),
  /**
   * Redacted screen frames (`frame.received`) recorded in this session. Every rule the expert confirms
   * cites at least one: with none, confirmations are refused (409 `no_screen_frame`).
   */
  screenFrames: z.int().nonnegative(),
  llmAvailable: z.boolean(),
});
export type DebriefState = z.infer<typeof DebriefStateSchema>;

/** Conditions of a stop-rule in the answer parser's flat form; the server converts and type-checks them. */
export const StopRuleConditionsSchema = z.strictObject({
  combinator: z.enum(["all", "any"]),
  conditions: z.array(LlmConditionSchema).min(1).max(8),
});
export type StopRuleConditions = z.infer<typeof StopRuleConditionsSchema>;

/**
 * What a stop-rule enforces: `forbid` the action outright, or `require_approval` from a role (from the
 * fixed list) before the action may be taken.
 */
export const StopRuleEffectSchema = z.discriminatedUnion("type", [
  z.strictObject({ type: z.literal("forbid"), action: ActionIdSchema }),
  z.strictObject({ type: z.literal("require_approval"), role: ApprovalRoleSchema, action: ActionIdSchema }),
]);
export type StopRuleEffect = z.infer<typeof StopRuleEffectSchema>;

/** POST /api/sessions/:sessionId/debrief — an explicit expert action from the UI (voice unavailable). */
export const ExpertActionRequestSchema = z.discriminatedUnion("action", [
  z.strictObject({ action: z.literal("confirm_candidate"), candidateId: IdSchema, decisionFamily: z.string().min(1), quote: ExpertQuoteSchema }),
  z.strictObject({ action: z.literal("add_rule_for_witness"), witnessId: IdSchema, decision: ActionIdSchema, quote: ExpertQuoteSchema }),
  z.strictObject({
    action: z.literal("revise_rule"),
    ruleId: IdSchema,
    predicate: PredicateSchema.optional(),
    priority: z.int().min(-1000).max(1000).optional(),
    overrides: z.array(IdSchema).max(50).optional(),
    /** The witness this revision answers (conflict / boundary), if any. */
    witnessId: IdSchema.optional(),
    /** The teach-back this revision corrects, if any. */
    teachBackId: IdSchema.optional(),
    quote: ExpertQuoteSchema,
  }),
  z.strictObject({
    action: z.literal("acknowledge_witness"),
    witnessId: IdSchema,
    resolution: z.enum(["escalate_to_controller", "out_of_scope"]),
    quote: ExpertQuoteSchema,
  }),
  z.strictObject({ action: z.literal("confirm_boundary"), witnessId: IdSchema, quote: ExpertQuoteSchema }),
  z.strictObject({ action: z.literal("confirm_teachback"), teachBackId: IdSchema, quote: ExpertQuoteSchema }),
  /**
   * A decision rule the expert stated in their own words ("a company whose owner holds over 25% and isn't
   * verified goes to enhanced review"), read back and confirmed in the debrief conversation. The conditions
   * are converted and type-checked against the domain like a stop-rule's.
   */
  z.strictObject({
    action: z.literal("confirm_stated_rule"),
    decisionFamily: z.string().min(1),
    when: StopRuleConditionsSchema,
    decision: ActionIdSchema,
    quote: ExpertQuoteSchema,
  }),
  /**
   * "Never approve a customer on a high-risk country list at desk level": a guardrail the expert states
   * outright. Confirmed with the expert's exact words and the redacted screen frame of `momentEntryId`
   * (a decision, frame or screen event of this session; default: the latest frame) — refused with 409
   * `no_screen_frame` when no frame was captured at or before that moment.
   */
  z.strictObject({
    action: z.literal("confirm_stop_rule"),
    decisionFamily: z.string().min(1),
    when: StopRuleConditionsSchema,
    effect: StopRuleEffectSchema,
    momentEntryId: IdSchema.optional(),
    quote: ExpertQuoteSchema,
  }),
  /**
   * The expert deletes a live confirmed rule, in their own words (the audit trail): recorded as
   * `rule.retired`. Rules of this expert that override it drop the dangling id in a `rule.revised`.
   */
  z.strictObject({ action: z.literal("retire_rule"), ruleId: IdSchema, quote: ExpertQuoteSchema }),
]);
export type ExpertActionRequest = z.infer<typeof ExpertActionRequestSchema>;

export const ExpertActionResponseSchema = z.strictObject({
  /** The `expert.statement` entry holding the typed quote. */
  statementId: IdSchema,
  /** Entries derived from it (rule events, resolutions, confirmations, witnesses found after the rerun). */
  derivedIds: z.array(IdSchema),
  state: DebriefStateSchema,
});

export const LineageNodeViewSchema = z.strictObject({
  id: IdSchema,
  sessionId: IdSchema,
  sequence: z.int().nonnegative(),
  kind: z.string(),
  source: LedgerSourceSchema,
  stage: z.string(),
  role: z.enum(["ancestor", "focus", "descendant"]),
  occurredAt: z.int().nonnegative(),
  /** One line describing the entry, from its payload (never `system_control`). */
  summary: z.string(),
  /** For frames: the redacted image URL. */
  mediaUrl: z.string().nullable(),
});
export type LineageNodeView = z.infer<typeof LineageNodeViewSchema>;

/** GET /api/sessions/:sessionId/lineage?entryId=… */
export const LineageResponseSchema = z.strictObject({
  focus: IdSchema,
  nodes: z.array(LineageNodeViewSchema),
  edges: z.array(z.strictObject({ from: IdSchema, to: IdSchema, via: z.enum(["parent", "screen_moment"]) })),
});
export type LineageResponse = z.infer<typeof LineageResponseSchema>;

export const ScreenMomentSchema = z.strictObject({
  entryId: IdSchema,
  kind: z.enum(["frame", "dom_event", "vision_event"]),
  summary: z.string(),
  mediaUrl: z.string().nullable(),
});

/** GET /api/sessions/:sessionId/workmap */
export const WorkMapResponseSchema = z.strictObject({
  workMap: WorkMapSchema,
  /** Who wrote the step titles and summary (non-authoritative either way). */
  proseOrigin: ProseOriginSchema,
  /** Saved export, relative to DATA_DIR/media. */
  exportPath: z.string(),
  generatedEntryId: IdSchema,
  /** Screen moment of each step, by step id: frames first, then screen events. */
  moments: z.record(z.string(), z.array(ScreenMomentSchema)),
  /** Plain-language rendering of each rule, by rule id. */
  ruleText: z.record(z.string(), z.strictObject({ when: z.string(), then: z.string(), entryId: IdSchema })),
  /** The session has voice utterances. ▶ clips need recorded conversation audio, which is retrieved in P11. */
  voiceSession: z.boolean(),
  mcp: z.strictObject({ path: z.literal("/mcp"), tool: z.literal("check_action"), bearerRequired: z.boolean(), rulebookRevision: z.int().nonnegative() }),
});
export type WorkMapResponse = z.infer<typeof WorkMapResponseSchema>;

/** GET /api/rulebook — the confirmed rulebook in force: the team rulebook (all expert sessions; decision rules of open disagreements held back). */
export const RulebookResponseSchema = z.strictObject({
  revision: z.int().nonnegative(),
  rules: z.array(ConfirmedRuleSchema),
});


// ── The debrief conversation (chat or voice) ──

export const DebriefTopicSchema = z.enum(["proposal", "unexplained", "witness", "concept", "stop_rules", "teach_back", "readback", "closing"]);

/** One line of the debrief conversation, from its ledger entry. */
export const DebriefTurnSchema = z.strictObject({
  /** The `debrief.asked` / `debrief.replied` entry. */
  id: IdSchema,
  role: z.enum(["agent", "expert"]),
  text: z.string(),
  at: z.int().nonnegative(),
  /** How the expert replied; null for the agent. */
  via: z.enum(["chat", "voice"]).nullable(),
  /** For an expert turn: how it was read and what came of it. Null until read, and for the agent. */
  outcome: z
    .strictObject({
      readAs: z.enum(["yes", "no", "skip", "statement", "unclear"]),
      /** A free reply read by the model (a proposal, read back before anything was saved). */
      byModel: z.boolean(),
      /** The reply saved something (a rule, a resolution, a confirmation, a concept). */
      saved: z.boolean(),
      /** Why the code refused what the expert confirmed, if it did. */
      refused: z.string().nullable(),
    })
    .nullable(),
});
export type DebriefTurn = z.infer<typeof DebriefTurnSchema>;

/** GET / POST /api/sessions/:sessionId/debrief/conversation */
export const DebriefConversationSchema = z.strictObject({
  sessionId: IdSchema,
  turns: z.array(DebriefTurnSchema),
  /** The question waiting for the expert's reply, or null (not started, or finished). */
  awaiting: z.strictObject({ promptId: IdSchema, topic: DebriefTopicSchema, text: z.string() }).nullable(),
  /** Every agenda item has been talked through. The expert may still add a rule by saying it. */
  done: z.boolean(),
  /** Free replies can be read (a language model is configured); without it only yes / no / skip are understood. */
  llmAvailable: z.boolean(),
  /** What the page's voice loop needs: the session's privacy state and the expert's declared language. */
  session: z.strictObject({ offRecord: z.boolean(), privacyEpoch: z.int().nonnegative(), expertLanguage: ExpertLanguageSchema }),
  state: DebriefStateSchema,
});
export type DebriefConversation = z.infer<typeof DebriefConversationSchema>;

/** POST /api/sessions/:sessionId/debrief/conversation: start (or resume) the conversation, or reply in the expert's own words. */
export const DebriefConversationRequestSchema = z.discriminatedUnion("type", [
  z.strictObject({ type: z.literal("start") }),
  z.strictObject({ type: z.literal("reply"), text: z.string().trim().min(1).max(1000) }),
]);
export type DebriefConversationRequest = z.infer<typeof DebriefConversationRequestSchema>;
