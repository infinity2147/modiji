import { z } from "zod";
import { ActionIdSchema, EpochMsSchema, IdSchema, SchemaVersionSchema, SymbolIdSchema } from "./primitives";
import { ConfirmedRuleSchema, ExpertQuoteEvidenceSchema } from "./rules";

/**
 * The canonical Work Map (plan §7.6) — built deterministically by code from confirmed rules, the
 * ledger and evidence. LLMs only supply step titles and summaries (`title`, `summary`), which are
 * marked non-authoritative. Rejected candidates never appear here.
 */
export const WorkMapStepSchema = z.strictObject({
  id: IdSchema,
  order: z.int().nonnegative(),
  caseId: z.string().min(1),
  /** LLM-written, non-authoritative. */
  title: z.string().min(1),
  decision: z.strictObject({ decisionFamily: SymbolIdSchema, action: ActionIdSchema, ledgerEntryId: IdSchema }),
  /** Screen moment: redacted frames and the screen events of this step. */
  frameIds: z.array(IdSchema),
  eventIds: z.array(IdSchema),
  /** Confirmed rules that explain this decision. */
  ruleIds: z.array(IdSchema),
  /** The expert's own words for why (subset of the rules' evidence). */
  reasonQuotes: z.array(ExpertQuoteEvidenceSchema),
  guardrailIds: z.array(IdSchema),
});
export type WorkMapStep = z.infer<typeof WorkMapStepSchema>;

export const CoverageSchema = z.strictObject({
  decisionsExplained: z.strictObject({ explained: z.int().nonnegative(), total: z.int().nonnegative() }),
  unresolvedWitnesses: z.int().nonnegative(),
  /** Witnesses the expert explicitly marked "escalate to controller" / out of scope. */
  acknowledgedWitnesses: z.int().nonnegative(),
  undefinedConcepts: z.int().nonnegative(),
  teachBackConfirmed: z.boolean(),
  schemaVersion: SchemaVersionSchema,
  /** "No unresolved counterexample exists under the current feature model." — only when all hold. */
  closed: z.boolean(),
});
export type Coverage = z.infer<typeof CoverageSchema>;

export const WorkMapSchema = z.strictObject({
  format: z.literal("vashistha.workmap/1"),
  id: IdSchema,
  domainId: SymbolIdSchema,
  expertId: IdSchema,
  sessionIds: z.array(IdSchema).min(1),
  generatedAt: EpochMsSchema,
  schemaVersion: SchemaVersionSchema,
  rulebookRevision: z.int().nonnegative(),
  steps: z.array(WorkMapStepSchema),
  rules: z.array(ConfirmedRuleSchema),
  coverage: CoverageSchema,
  /** LLM-written, non-authoritative. */
  summary: z.string(),
});
export type WorkMap = z.infer<typeof WorkMapSchema>;
