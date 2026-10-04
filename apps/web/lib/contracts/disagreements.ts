/**
 * HTTP contract of the "Two experts" view (plan §7.10). Browser-safe: no oracle, no server modules.
 * Every status and decision here is computed by code from the ledger, the experts' confirmed rulebooks
 * and the solver; quotes are the experts' own words (a translation, when present, is labelled machine
 * output by the UI).
 */
import { z } from "zod";
import {
  ActionIdSchema,
  ConfirmedRuleSchema,
  ExpertIdSchema,
  ExpertLanguageSchema,
  ExpertSchema,
  IdSchema,
  SymbolIdSchema,
  WitnessSchema,
} from "@vashistha/core";
import { ExpertQuoteSchema } from "./debrief";

export const ExpertViewSchema = ExpertSchema.extend({
  /** False for an expert session started without a name (its own one-off expert). */
  named: z.boolean(),
  sessionIds: z.array(IdSchema).min(1),
});
export type ExpertView = z.infer<typeof ExpertViewSchema>;

export const RuleCardSchema = z.strictObject({
  rule: ConfirmedRuleSchema,
  when: z.string(),
  then: z.string(),
  /** Latest rule event entry (for its trace). */
  entryId: IdSchema.nullable(),
  /** Held back from the team rulebook by an open disagreement. */
  held: z.boolean(),
  /** The other experts who confirmed this rule too (a reconciled rule). */
  sharedWith: z.array(z.string()),
});
export type RuleCard = z.infer<typeof RuleCardSchema>;

/** One expert rulebook's effective decision on the disagreement case. */
export const BookDecisionSchema = z.strictObject({
  kind: z.enum(["decided", "unresolved", "conflict", "undetermined"]),
  action: ActionIdSchema.nullable(),
  label: z.string(),
  ruleIds: z.array(IdSchema),
});

export const AnswerQuoteSchema = z.strictObject({
  text: z.string().min(1),
  language: ExpertLanguageSchema.optional(),
  translation: z.string().optional(),
});

export const DisagreementAnswerSchema = z.strictObject({
  expertId: z.string(),
  action: ActionIdSchema,
  actionLabel: z.string(),
  quote: AnswerQuoteSchema,
  /** The `expert.statement` (typed) or `utterance.transcript` (voice) entry. */
  entryId: IdSchema,
  via: z.enum(["typed", "voice"]),
});
export type DisagreementAnswer = z.infer<typeof DisagreementAnswerSchema>;

export const RuleTextSchema = z.strictObject({ when: z.string(), then: z.string(), overrides: z.array(IdSchema), experts: z.array(z.string()) });

export const DisagreementResolutionSchema = z.strictObject({
  kind: z.enum(["rule_revised", "rule_added"]),
  ruleId: IdSchema,
  ledgerEntryId: IdSchema,
  revision: z.int().min(1),
  before: RuleTextSchema.nullable(),
  after: RuleTextSchema,
  fields: z.array(z.string()),
});

export const DisagreementStatusSchema = z.enum([
  /** Questions queued or asked; nobody has answered yet. */
  "asked",
  /** One expert answered. */
  "answered_one",
  /** Both answered, with different decisions: the disagreement stands (held back from the team rulebook). */
  "still_disagree",
  /** Both answered with the same decision and a resolution was written, but the solver still finds the case. */
  "agreed",
  /** Closed: `witness.resolved` (the solver no longer finds it). */
  "resolved",
]);

export const DisagreementViewSchema = z.strictObject({
  witness: WitnessSchema,
  status: DisagreementStatusSchema,
  /** The case in domain labels: one line per feature the two rulebooks read. */
  caseLines: z.array(z.strictObject({ feature: z.string(), label: z.string(), value: z.string() })),
  /** Each expert's rulebook decision on the case NOW (index 0 = first expert). */
  decisions: z.tuple([BookDecisionSchema, BookDecisionSchema]),
  /** Each expert's decision as recorded by the solver when the case was found. */
  foundActions: z.tuple([z.string(), z.string()]),
  questions: z.array(
    z.strictObject({ expertId: z.string(), questionId: IdSchema, text: z.string(), textEnglish: z.string().nullable(), status: z.string(), sessionId: IdSchema }),
  ),
  answers: z.tuple([DisagreementAnswerSchema.nullable(), DisagreementAnswerSchema.nullable()]),
  resolution: DisagreementResolutionSchema.nullable(),
  foundEntryIds: z.array(IdSchema),
});
export type DisagreementView = z.infer<typeof DisagreementViewSchema>;

export const PairStateSchema = z.strictObject({
  experts: z.tuple([ExpertViewSchema, ExpertViewSchema]),
  decisionFamily: SymbolIdSchema,
  familyLabel: z.string(),
  rulebooks: z.tuple([z.array(RuleCardSchema), z.array(RuleCardSchema)]),
  witnesses: z.array(DisagreementViewSchema),
  /** Every expert's rules of this family; those not `held` form the team rulebook the interlock, tutor and MCP evaluate. */
  team: z.array(RuleCardSchema),
  /** Open disagreements of this pair: the solver found a case and no resolution closed it. */
  open: z.int().nonnegative(),
});
export type PairState = z.infer<typeof PairStateSchema>;

/** GET /api/disagreements[?experts=a,b&family=f] — POST bodies return the same. */
export const DisagreementsStateSchema = z.strictObject({
  experts: z.array(ExpertViewSchema),
  families: z.array(z.strictObject({ id: SymbolIdSchema, label: z.string() })),
  pair: PairStateSchema.nullable(),
});
export type DisagreementsState = z.infer<typeof DisagreementsStateSchema>;

const PairSchema = z.tuple([ExpertIdSchema, ExpertIdSchema]).refine(([a, b]) => a !== b, { message: "two different experts" });

/** POST /api/disagreements — search the two experts' rulebooks (Z3), record and ask; apply answers; resolve. */
export const SearchDisagreementsRequestSchema = z.strictObject({ experts: PairSchema, decisionFamily: SymbolIdSchema });

/** POST /api/disagreements/answer — one expert's decision on a disagreement case, in their own typed words. */
export const AnswerDisagreementRequestSchema = z.strictObject({
  experts: PairSchema,
  decisionFamily: SymbolIdSchema,
  witnessId: IdSchema,
  expertId: ExpertIdSchema,
  decision: ActionIdSchema,
  quote: ExpertQuoteSchema,
});

export const SearchDisagreementsResponseSchema = z.strictObject({ written: z.array(IdSchema), state: DisagreementsStateSchema });
export const AnswerDisagreementResponseSchema = z.strictObject({ statementId: IdSchema, written: z.array(IdSchema), state: DisagreementsStateSchema });
