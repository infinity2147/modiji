import { z } from "zod";
import { ExpertLanguageSchema } from "./expert";
import { ActionIdSchema, EpochMsSchema, IdSchema, SchemaVersionSchema, SymbolIdSchema } from "./primitives";
import { PredicateSchema } from "./predicate";

export const CandidateOriginSchema = z.enum(["enumerated", "llm", "expert_statement"]);

export const CandidateRuleSchema = z.strictObject({
  id: IdSchema,
  hypothesisSetId: IdSchema,
  predicate: PredicateSchema,
  predictedAction: ActionIdSchema,
  /** Normalised within the hypothesis set. Weight exists only on candidates, never on confirmed rules. */
  weight: z.number().min(0).max(1),
  complexity: z.int().nonnegative(),
  origin: CandidateOriginSchema,
});
export type CandidateRule = z.infer<typeof CandidateRuleSchema>;

const WEIGHT_SUM_TOLERANCE = 1e-9;

export const HypothesisSetSchema = z
  .strictObject({
    id: IdSchema,
    decisionFamily: SymbolIdSchema,
    candidates: z.array(CandidateRuleSchema),
    normalizationVersion: z.int().nonnegative(),
    schemaVersion: SchemaVersionSchema,
  })
  .superRefine((s, ctx) => {
    for (const c of s.candidates)
      if (c.hypothesisSetId !== s.id)
        ctx.addIssue({ code: "custom", message: `candidate ${c.id} belongs to ${c.hypothesisSetId}, not ${s.id}` });
    if (s.candidates.length > 0) {
      const sum = s.candidates.reduce((acc, c) => acc + c.weight, 0);
      if (Math.abs(sum - 1) > WEIGHT_SUM_TOLERANCE)
        ctx.addIssue({ code: "custom", message: `candidate weights sum to ${sum}, expected 1` });
    }
  });
export type HypothesisSet = z.infer<typeof HypothesisSetSchema>;

export const RuleEffectSchema = z.discriminatedUnion("type", [
  z.strictObject({ type: z.literal("recommend"), action: ActionIdSchema }),
  z.strictObject({ type: z.literal("require_approval"), role: z.string().min(1) }),
  z.strictObject({ type: z.literal("forbid"), action: ActionIdSchema }),
  z.strictObject({ type: z.literal("route"), destination: z.string().min(1) }),
]);
export type RuleEffect = z.infer<typeof RuleEffectSchema>;

export const ExpertQuoteEvidenceSchema = z
  .strictObject({
    kind: z.literal("expert_quote"),
    utteranceId: IdSchema,
    exactQuote: z.string().trim().min(1),
    t0Ms: z.int().nonnegative(),
    t1Ms: z.int().nonnegative(),
    frameIds: z.tuple([IdSchema], IdSchema),
    eventIds: z.array(IdSchema),
    relation: z.enum(["supports", "contradicts"]),
    provenance: z.enum(["human_voice", "human_text"]),
    /**
     * P10, any language: the language the expert spoke (absent = English). `exactQuote` is always the
     * expert's ORIGINAL words — the evidence; `translation` is its English rendering for display, a
     * model product that is never authoritative and never parsed back into a rule.
     */
    language: ExpertLanguageSchema.optional(),
    translation: z.string().trim().min(1).optional(),
  })
  .refine((e) => e.t1Ms >= e.t0Ms, { message: "t1Ms must be >= t0Ms", path: ["t1Ms"] })
  .refine((e) => e.translation === undefined || (e.language !== undefined && e.language !== "en"), {
    message: "a translation belongs to a quote in a language other than English",
    path: ["translation"],
  });
export type ExpertQuoteEvidence = z.infer<typeof ExpertQuoteEvidenceSchema>;

/** Non-quote evidence points at ledger entries. */
export const EvidenceLinkSchema = z.union([
  ExpertQuoteEvidenceSchema,
  z.strictObject({ kind: z.literal("frame"), frameId: IdSchema, ledgerEntryId: IdSchema }),
  z.strictObject({ kind: z.literal("screen_event"), eventId: IdSchema, ledgerEntryId: IdSchema }),
  z.strictObject({ kind: z.literal("observed_decision"), ledgerEntryId: IdSchema }),
]);
export type EvidenceLink = z.infer<typeof EvidenceLinkSchema>;

export const ConfirmationSchema = z.strictObject({
  expertId: IdSchema,
  at: EpochMsSchema,
  method: z.enum(["debrief", "explicit_statement", "teach_back", "sign_off"]),
  /** Ledger entry of the confirming utterance or UI action. */
  ledgerEntryId: IdSchema,
});
export type Confirmation = z.infer<typeof ConfirmationSchema>;

export const RuleKindSchema = z.enum(["decision", "guardrail", "escalation", "exception"]);

export const ConfirmedRuleSchema = z
  .strictObject({
    id: IdSchema,
    decisionFamily: SymbolIdSchema,
    kind: RuleKindSchema,
    predicate: PredicateSchema,
    effect: RuleEffectSchema,
    /** Higher wins within a family. */
    priority: z.int(),
    /** Explicit override edges: ids of rules this rule overrides. */
    overrides: z.array(IdSchema),
    evidence: z.tuple([ExpertQuoteEvidenceSchema], EvidenceLinkSchema),
    confirmedBy: z.tuple([ConfirmationSchema], ConfirmationSchema),
    revision: z.int().min(1),
    schemaVersion: SchemaVersionSchema,
    expertId: IdSchema,
  })
  .superRefine((r, ctx) => {
    if (r.evidence[0].relation !== "supports")
      ctx.addIssue({ code: "custom", message: "first evidence item must be a supporting expert quote", path: ["evidence", 0] });
    if (r.overrides.includes(r.id)) ctx.addIssue({ code: "custom", message: "a rule cannot override itself", path: ["overrides"] });
  });
export type ConfirmedRule = z.infer<typeof ConfirmedRuleSchema>;
