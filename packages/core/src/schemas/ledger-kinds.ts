import { z } from "zod";
import { ActionIdSchema, EpochMsSchema, FeatureIdSchema, IdSchema, SchemaVersionSchema, SymbolIdSchema, ValueSchema } from "./primitives";
import { ParsedAnswerSchema, ProposedConceptSchema, QuestionSchema, WitnessResolutionSchema, WitnessSchema, MasteryLevelSchema } from "./engine";
import { GuardrailResultSchema } from "./guardrail";
import type { LedgerEntry, LedgerSource } from "./ledger";
import { ScreenEventSchema } from "./signals";

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
    }),
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
      language: z.string().min(2).optional(),
      /** English translation when the expert spoke another language (P10); quotes keep the original. */
      translation: z.string().optional(),
    }),
  },
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
  "concept.confirmed": {
    sources: ["expert", "voice"],
    payload: z.strictObject({ feature: FeatureIdSchema, schemaVersion: SchemaVersionSchema }),
  },
  "rule.confirmed": { sources: ["engine", "expert"], payload: z.looseObject({}) },
  "rule.revised": { sources: ["engine", "expert"], payload: z.looseObject({}) },
  "rule.retired": { sources: ["engine", "expert"], payload: z.looseObject({}) },

  // ── Debrief (P5) ──
  "witness.found": { sources: ["solver"], payload: WitnessSchema },
  "witness.resolved": { sources: ["engine"], payload: WitnessResolutionSchema },
  "teachback.generated": {
    sources: ["engine"],
    payload: z.strictObject({ text: z.string().min(1), ruleIds: z.array(IdSchema), rulebookRevision: z.int().nonnegative() }),
  },
  "teachback.confirmed": {
    sources: ["engine"],
    payload: z.strictObject({ utteranceId: IdSchema, rulebookRevision: z.int().nonnegative() }),
  },
  "workmap.generated": {
    sources: ["engine"],
    payload: z.strictObject({ workMapId: IdSchema, rulebookRevision: z.int().nonnegative(), mediaPath: z.string().min(1) }),
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
