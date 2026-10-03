/**
 * The deterministic Save interlock (plan §7.7). `POST /api/interlock/check` evaluates a proposed
 * review outcome against the confirmed rulebook and records the check; `POST
 * /api/sessions/:sessionId/decisions` commits an outcome that cites a matching check, re-running
 * the interlock first because the rulebook may have changed in between. The server loads the case
 * itself: the client contributes only the case id, the action and the reviewer's edits.
 */
import { randomUUID } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { z } from "zod";
import {
  ActionIdSchema,
  GuardrailResultSchema,
  checkAction,
  unknown,
  validateFeatureValue,
  type ActionId,
  type FeatureLookup,
  type GuardrailResult,
  type LedgerEntry,
} from "@vashistha/core";
import { KYC_DOMAIN, caseFeatures, findKycCase, type KycCase } from "@vashistha/core/domains/kyc";
import {
  CommitDecisionRequestSchema,
  InterlockCheckRequestSchema,
  ReviewEditsSchema,
  type CommitDecisionResponseSchema,
  type InterlockCheckResponseSchema,
} from "../../contracts/casedesk";
import { ApiFailure, json, readJson, respond } from "./http";
import {
  CASEDESK_SCHEMA_VERSION,
  REVIEW_OUTCOME_ACTIONS,
  loadSession,
  requireOnRecord,
  type CaseDeskDeps,
  type LoadedSession,
} from "./session";

type ReviewEdits = z.infer<typeof ReviewEditsSchema>;
type CommitDecisionResponse = z.infer<typeof CommitDecisionResponseSchema>;

/** Payload of `engine` / `interlock.check`; read back when a decision cites the check. */
const InterlockCheckPayloadSchema = z.strictObject({
  caseId: z.string(),
  action: ActionIdSchema,
  edits: ReviewEditsSchema,
  result: GuardrailResultSchema,
});

const DecisionPayloadSchema = z.object({ caseId: z.string() });

function caseInSession(caseId: string, { info }: LoadedSession): KycCase {
  const found = findKycCase(caseId);
  if (found?.set !== info.caseSet)
    throw new ApiFailure(400, "unknown_case", `case ${caseId} is not in this session's ${info.caseSet} set`);
  return found;
}

function requireReviewOutcome(action: ActionId): void {
  if (!REVIEW_OUTCOME_ACTIONS.has(action))
    throw new ApiFailure(400, "invalid_action", `${action} is not a terminal review-outcome action`);
}

/** Each edit must be a valid value of its domain feature (the domain, not the contract, is authoritative). */
function checkEdits(edits: ReviewEdits): void {
  for (const [field, value] of Object.entries(edits)) {
    if (value === undefined) continue;
    const result = validateFeatureValue(KYC_DOMAIN, field, value);
    if (!result.ok) throw new ApiFailure(400, "invalid_value", `edits.${field}: ${result.message}`);
  }
}

/** The interlock itself: confirmed rules over the case's derived features with the reviewer's edits applied. */
function evaluate(deps: CaseDeskDeps, kycCase: KycCase, edits: ReviewEdits, action: ActionId): GuardrailResult {
  const features = caseFeatures(kycCase, edits.riskRating === undefined ? {} : { riskRating: edits.riskRating });
  const lookup: FeatureLookup = (id) => (Object.hasOwn(features, id) ? features[id] : undefined) ?? unknown("not_extracted");
  return checkAction({ rules: deps.rulebook(), features: lookup, action, domain: KYC_DOMAIN });
}

export function handleInterlockCheck(request: Request, deps: CaseDeskDeps): Promise<Response> {
  return respond(deps.log, async () => {
    const { sessionId, caseId, edits, proposedAction } = await readJson(request, InterlockCheckRequestSchema);
    const loaded = loadSession(deps, sessionId);
    // The check records what the reviewer is doing, so it follows the capture rules (plan §7.8).
    requireOnRecord(loaded.session);
    requireReviewOutcome(proposedAction);
    checkEdits(edits);
    const result = evaluate(deps, caseInSession(caseId, loaded), edits, proposedAction);
    const entry = deps.ledger.append({
      sessionId: loaded.session.id,
      source: "engine",
      kind: "interlock.check",
      occurredAt: deps.now(),
      traceId: randomUUID(),
      parentIds: [loaded.info.startedEntryId],
      schemaVersion: CASEDESK_SCHEMA_VERSION,
      privacyEpoch: loaded.session.privacyEpoch,
      payload: { caseId, action: proposedAction, edits, result } satisfies z.input<typeof InterlockCheckPayloadSchema>,
    });
    const body: z.infer<typeof InterlockCheckResponseSchema> = { result, checkId: entry.id };
    return json(body);
  });
}

/** The cited check must be this session's `interlock.check` for exactly this case, action and edits. */
function citedCheck(
  deps: CaseDeskDeps,
  sessionId: string,
  checkId: string,
  request: { caseId: string; action: ActionId; edits: ReviewEdits },
): LedgerEntry {
  const entry = deps.ledger.get(checkId);
  const payload =
    entry?.sessionId === sessionId && entry.source === "engine" && entry.kind === "interlock.check"
      ? InterlockCheckPayloadSchema.parse(entry.payload)
      : undefined;
  if (!entry || !payload) throw new ApiFailure(409, "check_mismatch", `${checkId} is not an interlock check of this session`);
  if (
    payload.caseId !== request.caseId ||
    payload.action !== request.action ||
    !isDeepStrictEqual(payload.edits, request.edits)
  )
    throw new ApiFailure(409, "check_mismatch", "the cited check was for a different case, action or edits");
  return entry;
}

function requireUndecided(deps: CaseDeskDeps, sessionId: string, caseId: string): void {
  const decided = deps.ledger
    .list(sessionId, { sources: ["dom"], kinds: ["case.decision"] })
    .some((entry) => DecisionPayloadSchema.parse(entry.payload).caseId === caseId);
  if (decided) throw new ApiFailure(409, "already_decided", `case ${caseId} already has a decision in this session`);
}

export function handleCommitDecision(request: Request, sessionId: string, deps: CaseDeskDeps): Promise<Response> {
  return respond(deps.log, async () => {
    const { caseId, edits, action, checkId, override } = await readJson(request, CommitDecisionRequestSchema);
    const loaded = loadSession(deps, sessionId);
    const { session } = loaded;
    requireOnRecord(session);
    requireReviewOutcome(action);
    checkEdits(edits);
    const check = citedCheck(deps, session.id, checkId, { caseId, action, edits });
    requireUndecided(deps, session.id, caseId);

    const result = evaluate(deps, caseInSession(caseId, loaded), edits, action);
    // allow commits as is; forbid never commits; the rest commit only when acknowledged or escalated.
    const commits = result.decision === "allow" || (result.decision !== "forbid" && override !== undefined);
    const usedOverride = result.decision !== "allow" && override !== undefined ? { override } : {};
    const entry = deps.ledger.append({
      sessionId: session.id,
      // A committed decision is an observed reviewer action (capture, so the privacy epoch applies);
      // a refusal is the engine's.
      source: commits ? "dom" : "engine",
      kind: commits ? "case.decision" : "interlock.blocked",
      occurredAt: deps.now(),
      traceId: check.traceId,
      parentIds: [check.id],
      schemaVersion: CASEDESK_SCHEMA_VERSION,
      privacyEpoch: session.privacyEpoch,
      payload: { caseId, action, edits, ...usedOverride, result },
    });
    const body: CommitDecisionResponse = commits
      ? { status: "committed", decisionId: entry.id, result }
      : { status: "blocked", result };
    return json(body, commits ? 200 : 409);
  });
}
