/**
 * The client half of the Save interlock (plan §7.7). The decision itself is made by server code
 * (`/api/interlock/check`, re-run on commit); this module only sequences the calls and turns the
 * results into what the UI must show: committed, blocked, or an acknowledgement/escalation prompt.
 */
import type { ActionId, GuardrailResult } from "@vashistha/core";
import { checkInterlock, commitDecision, type FetchFn } from "./api";
import { interlockPrompt } from "./domain";
import type { DecisionOverride, DecisionRecord, RiskRating } from "./session-state";

export type SaveRequest = {
  sessionId: string;
  caseId: string;
  action: ActionId;
  riskRating: RiskRating;
};

export type SaveOutcome =
  | { kind: "committed"; decision: DecisionRecord }
  /** `forbid`: no commit is possible. */
  | { kind: "blocked"; checkId: string; result: GuardrailResult }
  /** `needs_approval` / `insufficient_information`: commit only with an acknowledgement or escalation. */
  | { kind: "needs_override"; checkId: string; result: GuardrailResult };

export type SaveDeps = {
  fetch: FetchFn;
  /** Delivers pending DOM events first, so the ledger shows what the reviewer did before the check. */
  flushEvents: () => Promise<void>;
};

function refusal(checkId: string, result: GuardrailResult): SaveOutcome {
  return interlockPrompt(result) === "needs_override"
    ? { kind: "needs_override", checkId, result }
    : { kind: "blocked", checkId, result };
}

/** Commits an outcome that cites `checkId`; a server-side refusal (the rulebook changed since the check) is returned as such. */
export async function commit(
  fetchFn: FetchFn,
  request: SaveRequest,
  checkId: string,
  override?: DecisionOverride,
): Promise<SaveOutcome> {
  const response = await commitDecision(fetchFn, request.sessionId, {
    caseId: request.caseId,
    edits: { riskRating: request.riskRating },
    action: request.action,
    checkId,
    ...(override !== undefined && { override }),
  });
  if (response.status === "blocked") return refusal(checkId, response.result);
  return {
    kind: "committed",
    decision: {
      caseId: request.caseId,
      action: request.action,
      riskRating: request.riskRating,
      decisionId: response.decisionId,
      override: response.result.decision === "allow" ? undefined : override,
      result: response.result,
    },
  };
}

/** Save: flush events → interlock check → commit when allowed, otherwise report what the reviewer must do. */
export async function save(deps: SaveDeps, request: SaveRequest): Promise<SaveOutcome> {
  await deps.flushEvents();
  const { result, checkId } = await checkInterlock(deps.fetch, {
    sessionId: request.sessionId,
    caseId: request.caseId,
    edits: { riskRating: request.riskRating },
    proposedAction: request.action,
  });
  if (interlockPrompt(result) !== "commit") return refusal(checkId, result);
  return commit(deps.fetch, request, checkId);
}
