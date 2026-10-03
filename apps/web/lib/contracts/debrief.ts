/**
 * HTTP contract of the debrief, Work Map and lineage views (P5, plan §7.5–7.6). Browser-safe: no
 * oracle, no server modules. Every number and status here is computed by code from the ledger and the
 * confirmed rulebook; the only model-written text is marked by an `origin` of "llm".
 */
import { z } from "zod";
import {
  ActionIdSchema,
  ConfirmedRuleSchema,
  CoverageSchema,
  IdSchema,
  LedgerSourceSchema,
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
  llmAvailable: z.boolean(),
});
export type DebriefState = z.infer<typeof DebriefStateSchema>;

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

/** GET /api/rulebook — the confirmed rulebook in force (all expert sessions). */
export const RulebookResponseSchema = z.strictObject({
  revision: z.int().nonnegative(),
  rules: z.array(ConfirmedRuleSchema),
});

