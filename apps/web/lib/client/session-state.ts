/**
 * Resuming a CaseDesk session from its ledger (`GET /api/sessions/:id/ledger`): the session's mode
 * and case set, its current privacy epoch, the last DOM frame it accepted, and the decisions already
 * committed. The ledger is the only source of truth, so a reload shows exactly what was recorded.
 */
import { z } from "zod";
import { ActionIdSchema, GuardrailResultSchema, type ActionId, type GuardrailResult, type LedgerEntry } from "@vashistha/core";
import { CaseSetSchema, RiskRatingSchema, type CaseSet } from "@vashistha/core/domains/kyc";
import { CommitDecisionRequestSchema, SessionModeSchema, type SessionMode } from "../contracts/casedesk";
import { LEDGER_PAGE_MAX } from "../contracts/ledger";
import { ApiError, fetchLedgerPage, type FetchFn } from "./api";

export type DecisionOverride = NonNullable<z.infer<typeof CommitDecisionRequestSchema>["override"]>;
export type RiskRating = z.infer<typeof RiskRatingSchema>;

/** A committed review outcome as the UI shows it. */
export type DecisionRecord = {
  caseId: string;
  action: ActionId;
  riskRating: RiskRating | undefined;
  decisionId: string;
  override: DecisionOverride | undefined;
  result: GuardrailResult;
};

export type SessionState = {
  mode: SessionMode;
  caseSet: CaseSet;
  privacyEpoch: number;
  /** Highest frameSeq of a recorded DOM screen event; 0 when none. */
  lastFrameSeq: number;
  decisions: ReadonlyMap<string, DecisionRecord>;
};

/* Only the members the UI reads; unknown members are tolerated so newer payload versions still resume. */
const StartedPayloadSchema = z.object({ mode: SessionModeSchema, caseSet: CaseSetSchema });
const ScreenEventPayloadSchema = z.object({ frameSeq: z.int().nonnegative() });
const DecisionPayloadSchema = z.object({
  caseId: z.string().min(1),
  action: ActionIdSchema,
  edits: z.object({ riskRating: RiskRatingSchema.optional() }),
  override: CommitDecisionRequestSchema.shape.override,
  result: GuardrailResultSchema,
});

function payload<S extends z.ZodType>(schema: S, entry: LedgerEntry): z.infer<S> {
  const parsed = schema.safeParse(entry.payload);
  if (!parsed.success)
    throw new ApiError("invalid_response", 200, "ledger_payload", `${entry.kind} entry ${entry.id} has an unexpected payload`);
  return parsed.data;
}

/** Folds ledger entries (oldest first) into the state CaseDesk needs to resume. */
export function summariseLedger(entries: readonly LedgerEntry[]): SessionState {
  const started = entries.find((e) => e.source === "engine" && e.kind === "session.started");
  if (!started) throw new ApiError("invalid_response", 200, "not_a_casedesk_session", "the session has no session.started entry");
  const { mode, caseSet } = payload(StartedPayloadSchema, started);
  let privacyEpoch = 0;
  let lastFrameSeq = 0;
  const decisions = new Map<string, DecisionRecord>();
  for (const entry of entries) {
    privacyEpoch = Math.max(privacyEpoch, entry.privacyEpoch);
    if (entry.source !== "dom") continue;
    if (entry.kind === "screen.event") lastFrameSeq = Math.max(lastFrameSeq, payload(ScreenEventPayloadSchema, entry).frameSeq);
    if (entry.kind === "case.decision") {
      const decision = payload(DecisionPayloadSchema, entry);
      decisions.set(decision.caseId, {
        caseId: decision.caseId,
        action: decision.action,
        riskRating: decision.edits.riskRating,
        decisionId: entry.id,
        override: decision.override,
        result: decision.result,
      });
    }
  }
  return { mode, caseSet, privacyEpoch, lastFrameSeq, decisions };
}

/** Reads the whole session ledger page by page. */
export async function readLedger(fetchFn: FetchFn, sessionId: string): Promise<LedgerEntry[]> {
  const entries: LedgerEntry[] = [];
  let after: number | undefined;
  for (;;) {
    const page = await fetchLedgerPage(fetchFn, sessionId, after, LEDGER_PAGE_MAX);
    entries.push(...page.entries);
    const last = page.entries.at(-1);
    if (page.entries.length < LEDGER_PAGE_MAX || last === undefined) return entries;
    after = last.sequence;
  }
}
