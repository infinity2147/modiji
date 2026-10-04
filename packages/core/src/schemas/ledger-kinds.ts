import { z } from "zod";
import { AGENT_ROLES } from "../agents";
import { SET_OFF_RECORD_TOOL } from "../voice/off-record";
import { ActionIdSchema, EpochMsSchema, FeatureIdSchema, IdSchema, SchemaVersionSchema, SymbolIdSchema, ValueSchema } from "./primitives";
import {
  ConceptConfirmedPayloadSchema,
  ConceptDismissedPayloadSchema,
  FeatureBackfilledPayloadSchema,
  SchemaVersionBumpedPayloadSchema,
} from "./concepts";
import { ExpertLanguageSchema, ExpertSchema } from "./expert";
import { ParsedAnswerSchema, ProposedConceptSchema, QuestionSchema, WitnessResolutionSchema, WitnessSchema, MasteryLevelSchema } from "./engine";
import { GuardrailResultSchema } from "./guardrail";
import type { LedgerEntry, LedgerSource } from "./ledger";
import { ScreenEventSchema } from "./signals";
import { UtteranceTranslatedPayloadSchema } from "./translation";

/**
 * Registry of ledger entry kinds: which sources may write each kind and the payload schema. Writers
 * validate with `ledgerPayloadSchema(kind)` before appending; readers (ticker, compliance strip, Work Map,
 * lineage) parse with `parseLedgerPayload`. One place, so writers and readers cannot drift.
 */

/** Reviewer edits (domain-specific editable fields, validated by the writer against the domain). */
const ReviewEditsPayloadSchema = z.record(FeatureIdSchema, ValueSchema);
const OverrideSchema = z.strictObject({ kind: z.enum(["acknowledged", "escalated"]), note: z.string() });
const DecisionPayloadSchema = z.strictObject({
  caseId: z.string().min(1),
  action: ActionIdSchema,
  edits: ReviewEditsPayloadSchema,
  override: OverrideSchema.optional(),
  result: GuardrailResultSchema,
});

const kinds = {
  // ── CaseDesk (P1) ──
  "session.started": {
    sources: ["engine"],
    payload: z.strictObject({
      mode: z.enum(["expert", "novice"]),
      caseSet: z.string().min(1),
      domainId: SymbolIdSchema,
      schemaVersion: SchemaVersionSchema,
      /** Expert capture sessions since P10: who the expert is and the language they speak (plan §7.10–7.11). */
      expert: ExpertSchema.optional(),
    }),
  },
  /**
   * Session lifecycle: the session is closed for writing (a published replay exposes its id, and a
   * session id is a write capability). Appended by the operator archive route or `replay:export
   * --archive`; afterwards the ledger refuses every append to the session, while reads keep working.
   */
  "session.archived": {
    sources: ["engine"],
    payload: z.strictObject({ by: z.enum(["operator", "replay_export"]), note: z.string().trim().min(1).max(500).optional() }),
  },
  "screen.event": { sources: ["dom", "vision"], payload: ScreenEventSchema },
  "interlock.check": {
    sources: ["engine"],
    payload: z.strictObject({ caseId: z.string().min(1), action: ActionIdSchema, edits: ReviewEditsPayloadSchema, result: GuardrailResultSchema }),
  },
  "interlock.blocked": { sources: ["engine"], payload: DecisionPayloadSchema },
  /** An observed decision (expert capture) or a novice commit — the decision the Work Map step is built on. */
  "case.decision": { sources: ["dom"], payload: DecisionPayloadSchema },

  // ── Privacy (P0b/P7) ──
  "privacy.off_record": { sources: ["system_control"], payload: z.looseObject({ privacyEpoch: z.int().nonnegative() }) },
  "privacy.on_record": { sources: ["system_control"], payload: z.looseObject({ privacyEpoch: z.int().nonnegative() }) },
  /**
   * The custom LLM heard an off-record phrase and answered with the `set_off_record` client tool call (no
   * speech). Deliberately carries nothing of the utterance: not its text, not which phrase matched.
   */
  "privacy.phrase_detected": {
    sources: ["system_control"],
    payload: z.strictObject({ agent: z.enum(AGENT_ROLES), tool: z.literal(SET_OFF_RECORD_TOOL) }),
  },

  // ── Perception (P2) ──
  "frame.received": {
    sources: ["client"],
    payload: z.strictObject({
      frameId: IdSchema,
      frameSeq: z.int().nonnegative(),
      captureTime: EpochMsSchema,
      width: z.int().positive(),
      height: z.int().positive(),
      /** Path of the redacted frame relative to DATA_DIR/media. */
      mediaPath: z.string().min(1),
      redactedRegions: z.int().nonnegative(),
      changeScore: z.number().nonnegative(),
    }),
  },

  // ── Gate + voice (P3) ──
  "question.queued": { sources: ["engine"], payload: QuestionSchema },
  "question.dropped": {
    sources: ["engine"],
    payload: z.strictObject({ questionId: IdSchema, reason: z.enum(["answered_by_screen", "superseded", "context_changed", "budget"]) }),
  },
  /**
   * An authorized question went unspoken: its authorization expired with no `speak` decision for its
   * nonce (the control message never reached the agent, was withheld because the expert resumed, or was
   * merged into an open user turn and skipped). The question is queued again — not asked, and not
   * counted against the live budget. Parent: its `gate.authorized` entry.
   */
  "question.requeued": {
    sources: ["engine"],
    payload: z.strictObject({ questionId: IdSchema, reason: z.literal("authorization_unspoken") }),
  },
  "gate.authorized": {
    sources: ["engine"],
    payload: z.strictObject({
      questionId: IdSchema,
      contextVersion: z.int().nonnegative(),
      becameValidAt: EpochMsSchema,
      decidedAt: EpochMsSchema,
      /** Per-condition snapshot shown on the HUD at the moment of authorization. */
      conditions: z.record(z.string(), z.boolean()),
    }),
  },
  "gate.authorization_issued": { sources: ["engine"], payload: z.looseObject({}) },
  "gate.control_message": { sources: ["system_control"], payload: z.looseObject({}) },
  "llm.turn_decision": { sources: ["engine"], payload: z.looseObject({ decision: z.enum(["speak", "skip_turn"]) }) },
  "llm.stream_aborted": { sources: ["engine"], payload: z.looseObject({}) },
  /** What the expert said (evidence). Times are ms from the start of the voice conversation. */
  "utterance.transcript": {
    sources: ["voice"],
    payload: z.strictObject({
      conversationId: z.string().min(1),
      text: z.string().trim().min(1),
      t0Ms: z.int().nonnegative(),
      t1Ms: z.int().nonnegative(),
      /** Redacted frames on screen while the expert spoke (nearest preceding frame at minimum). */
      frameIds: z.array(IdSchema),
      /**
       * P10: the language the expert spoke, detected by code when the utterance is recorded (absent =
       * English). `text` is always the original words; its English translation, a model product, is a
       * separate `utterance.translated` entry so that provenance (voice vs engine) stays per entry.
       */
      language: ExpertLanguageSchema.optional(),
    }),
  },
  /** Machine translation of a non-English `utterance.transcript` (its parent); display only, never evidence of its own. */
  "utterance.translated": { sources: ["engine"], payload: UtteranceTranslatedPayloadSchema },
  /** What the agent said (never evidence). */
  "agent.utterance": {
    sources: ["engine"],
    payload: z.strictObject({ conversationId: z.string().min(1), questionId: IdSchema.optional(), text: z.string().min(1) }),
  },

  // ── Hypothesis engine (P4) ──
  "answer.parsed": { sources: ["engine"], payload: ParsedAnswerSchema },
  "hypotheses.updated": {
    sources: ["engine"],
    payload: z.strictObject({
      decisionFamily: SymbolIdSchema,
      hypothesisSetId: IdSchema,
      top: z.array(z.strictObject({ candidateId: IdSchema, description: z.string(), weight: z.number().min(0).max(1) })),
      surpriseBits: z.number().nonnegative().optional(),
      contradiction: z.boolean(),
    }),
  },
  "concept.proposed": { sources: ["engine"], payload: ProposedConceptSchema },
  /**
   * The expert confirmed a proposed concept as a feature (plan §6.6): typed (`expert`) or spoken
   * (`voice`, the utterance is a parent). Parents: the proposal entries it confirms.
   */
  "concept.confirmed": { sources: ["expert", "voice"], payload: ConceptConfirmedPayloadSchema },
  /** The expert rejected a proposed concept ("not a real concept" / "already covered by <feature>"). */
  "concept.dismissed": { sources: ["expert", "voice"], payload: ConceptDismissedPayloadSchema },
  /** The session's feature model gained the confirmed concept; parent: the `concept.confirmed` entry. */
  "schema.version_bumped": { sources: ["engine"], payload: SchemaVersionBumpedPayloadSchema },
  /**
   * The value of a confirmed concept for one observed decision, re-read from the case's stored redacted
   * frames, or `Unknown{backfill_failed}` with why. Parents: the bump, the decision, the frames read.
   */
  "feature.backfilled": { sources: ["engine"], payload: FeatureBackfilledPayloadSchema },
  "rule.confirmed": { sources: ["engine", "expert"], payload: z.looseObject({}) },
  "rule.revised": { sources: ["engine", "expert"], payload: z.looseObject({}) },
  "rule.retired": { sources: ["engine", "expert"], payload: z.looseObject({}) },

  // ── Debrief (P5) ──
  "witness.found": { sources: ["solver"], payload: WitnessSchema },
  "witness.resolved": { sources: ["engine"], payload: WitnessResolutionSchema },
  /**
   * An explicit expert action typed in the debrief UI when voice is not used. `text` is the expert's
   * own words: it becomes evidence (`human_text`) exactly like an utterance; derived entries
   * (`rule.*`, `witness.resolved`, `teachback.confirmed`) cite it as their parent.
   */
  "expert.statement": {
    sources: ["expert"],
    payload: z.strictObject({
      text: z.string().trim().min(1).max(1000),
      intent: z.enum([
        "confirm_candidate",
        "add_rule_for_witness",
        "revise_rule",
        "acknowledge_witness",
        "confirm_boundary",
        "confirm_teachback",
        "confirm_stop_rule",
        /** Two experts (plan §7.10): this expert's decision on a disagreement case (`target.witnessId`, `target.action`). */
        "answer_disagreement",
      ]),
      target: z.strictObject({
        ruleId: IdSchema.optional(),
        witnessId: IdSchema.optional(),
        candidateId: IdSchema.optional(),
        teachBackId: IdSchema.optional(),
        action: ActionIdSchema.optional(),
      }),
    }),
  },
  "teachback.generated": {
    sources: ["engine"],
    payload: z.strictObject({
      text: z.string().min(1),
      ruleIds: z.array(IdSchema),
      rulebookRevision: z.int().nonnegative(),
      /** "llm": Opus prose (non-authoritative); "template": deterministic text from the rules, no model involved. */
      origin: z.enum(["llm", "template"]),
    }),
  },
  "teachback.confirmed": {
    sources: ["engine"],
    payload: z.strictObject({ utteranceId: IdSchema, rulebookRevision: z.int().nonnegative() }),
  },
  "workmap.generated": {
    sources: ["engine"],
    payload: z.strictObject({
      workMapId: IdSchema,
      rulebookRevision: z.int().nonnegative(),
      mediaPath: z.string().min(1),
      /** Who wrote the step titles and summary (non-authoritative either way). */
      proseOrigin: z.enum(["llm", "template"]),
    }),
  },

  // ── Tutor (P6) ──
  "tutor.prediction": {
    sources: ["client"],
    payload: z.strictObject({
      caseId: z.string().min(1),
      ruleIds: z.array(IdSchema),
      predicted: ActionIdSchema,
      expected: ActionIdSchema,
      correct: z.boolean(),
    }),
  },
  "tutor.intervention": {
    sources: ["engine"],
    payload: z.strictObject({
      caseId: z.string().min(1),
      trigger: z.enum(["guardrail_violation", "insufficient_information"]),
      proposedAction: ActionIdSchema,
      ruleIds: z.array(IdSchema),
      questionId: IdSchema,
    }),
  },
  "mastery.updated": {
    sources: ["engine"],
    payload: z.strictObject({ ruleId: IdSchema, from: MasteryLevelSchema, to: MasteryLevelSchema }),
  },
  /**
   * DOM channel: the novice selected a review outcome (not yet saved). The tutor's guardrail monitor
   * evaluates every intent; an intervention cites it as its parent.
   */
  "tutor.intent": {
    sources: ["dom"],
    payload: z.strictObject({ caseId: z.string().min(1), proposedAction: ActionIdSchema, edits: ReviewEditsPayloadSchema }),
  },
  /**
   * A synthetic case made available to one session: an unseen practice case built from a solver
   * boundary witness (`engine`), or a case a judge entered by hand (`client`). `case` is the domain's
   * case record; readers validate it with the domain's case schema.
   */
  "case.generated": {
    sources: ["engine", "client"],
    payload: z.strictObject({
      domainId: SymbolIdSchema,
      case: z.looseObject({ id: z.string().min(1) }),
      origin: z.discriminatedUnion("kind", [
        z.strictObject({
          kind: z.literal("boundary_practice"),
          witnessId: IdSchema,
          ruleId: IdSchema,
          feature: FeatureIdSchema,
          threshold: z.number(),
          side: z.enum(["at", "below", "above"]),
        }),
        z.strictObject({ kind: z.literal("judge") }),
      ]),
    }),
  },
} as const satisfies Record<string, { sources: readonly LedgerSource[]; payload: z.ZodType }>;

export const LEDGER_KINDS = kinds;
export type LedgerKind = keyof typeof kinds;
export type LedgerPayload<K extends LedgerKind> = z.infer<(typeof kinds)[K]["payload"]>;

export function isLedgerKind(kind: string): kind is LedgerKind {
  return Object.hasOwn(kinds, kind);
}

export function ledgerPayloadSchema<K extends LedgerKind>(kind: K): (typeof kinds)[K]["payload"] {
  return kinds[kind].payload;
}

/** Validates kind, source and payload together; throws on any mismatch (a writer bug or a tampered entry). */
export function parseLedgerPayload<K extends LedgerKind>(entry: Pick<LedgerEntry, "kind" | "source" | "payload">, kind: K): LedgerPayload<K> {
  if (entry.kind !== kind) throw new TypeError(`expected a ${kind} entry, got ${entry.kind}`);
  const spec = kinds[kind];
  if (!(spec.sources as readonly LedgerSource[]).includes(entry.source))
    throw new TypeError(`${kind} may not be written by source ${entry.source}`);
  return spec.payload.parse(entry.payload) as LedgerPayload<K>;
}
