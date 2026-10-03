/**
 * HTTP contract between the CaseDesk UI and the server (P1). Both sides import these schemas, so
 * requests are validated on the server and responses on the client. Browser-safe: no oracle, no
 * server modules.
 */
import { z } from "zod";
import {
  ActionIdSchema,
  GuardrailResultSchema,
  IdSchema,
  ScreenEventSchema,
} from "@vashistha/core";
import { CaseSetSchema, KycCaseSchema, RiskRatingSchema } from "@vashistha/core/domains/kyc";

export const SessionModeSchema = z.enum(["expert", "novice"]);
export type SessionMode = z.infer<typeof SessionModeSchema>;

/** POST /api/sessions */
export const CreateSessionRequestSchema = z.strictObject({ mode: SessionModeSchema, caseSet: CaseSetSchema });
export const CreateSessionResponseSchema = z.strictObject({
  sessionId: IdSchema,
  mode: SessionModeSchema,
  caseSet: CaseSetSchema,
  privacyEpoch: z.int().nonnegative(),
  schemaVersion: z.int().min(1),
});

/** GET /api/cases?set=<CaseSet> — public case data only (never oracle labels). */
export const ListCasesResponseSchema = z.strictObject({ cases: z.array(KycCaseSchema) });

/**
 * POST /api/sessions/:sessionId/events — DOM-channel screen events (`source: "dom"`). The server
 * re-derives `critical` from the domain's critical fields, validates field values against feature
 * types, and rejects events from a stale privacy epoch with 409.
 */
export const PostEventsRequestSchema = z.strictObject({
  events: z.array(ScreenEventSchema).min(1).max(50),
});
export const PostEventsResponseSchema = z.strictObject({ ledgerIds: z.array(IdSchema) });

/** Reviewer-editable values sent with interlock checks and decisions; the server owns the rest of the case. */
export const ReviewEditsSchema = z.strictObject({ riskRating: RiskRatingSchema.optional() });

/** POST /api/interlock/check — the deterministic Save interlock (plan §7.7) over the confirmed rulebook. */
export const InterlockCheckRequestSchema = z.strictObject({
  sessionId: IdSchema,
  caseId: z.string().min(1),
  edits: ReviewEditsSchema,
  proposedAction: ActionIdSchema,
});
export const InterlockCheckResponseSchema = z.strictObject({
  result: GuardrailResultSchema,
  /** Ledger entry recording this check; a decision cites it. */
  checkId: IdSchema,
});

/**
 * POST /api/sessions/:sessionId/decisions — commit a review outcome. The server re-runs the interlock
 * (never trusting the client): `allow` commits; `forbid` is refused (409); `needs_approval` and
 * `insufficient_information` commit only with an acknowledgement or an escalation.
 */
export const CommitDecisionRequestSchema = z.strictObject({
  caseId: z.string().min(1),
  edits: ReviewEditsSchema,
  action: ActionIdSchema,
  checkId: IdSchema,
  override: z
    .strictObject({ kind: z.enum(["acknowledged", "escalated"]), note: z.string().trim().min(1).max(500) })
    .optional(),
});
export const CommitDecisionResponseSchema = z.discriminatedUnion("status", [
  z.strictObject({ status: z.literal("committed"), decisionId: IdSchema, result: GuardrailResultSchema }),
  z.strictObject({ status: z.literal("blocked"), result: GuardrailResultSchema }),
]);

/** Error body for every non-2xx CaseDesk response. */
export const ApiErrorSchema = z.strictObject({ error: z.string(), detail: z.string().optional() });
