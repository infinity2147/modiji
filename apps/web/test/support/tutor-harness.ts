/**
 * Shared setup for the tutor tests: an in-memory ledger; the real ledger-backed rulebook store (rules
 * are seeded as `rule.confirmed` entries of an expert session, as the debrief writes them); the real
 * CaseDesk, interview and tutor handlers wired together; the real Z3 practice solver. No model, no
 * network, no oracle.
 */
import { randomUUID } from "node:crypto";
import { expect } from "vitest";
import type { z } from "zod";
import { ConfirmedRuleSchema, LedgerEntrySchema, engineConfig, type ConfirmedRule, type LedgerEntry } from "@vashistha/core";
import { createLedger, openDatabase, type Ledger } from "@vashistha/core/server";
import { createAuthorizationStore, type AuthorizationStore } from "../../lib/server/authorizations";
import { handleCommitDecision, handleInterlockCheck } from "../../lib/server/casedesk/interlock";
import { handlePostEvents } from "../../lib/server/casedesk/events";
import { handleCreateSession, handleListCases } from "../../lib/server/casedesk/sessions";
import { createCaseDeskStore, type CaseDeskDeps } from "../../lib/server/casedesk/session";
import { createLedgerRulebook } from "../../lib/server/debrief/rulebook-store";
import { createInterviewStore } from "../../lib/server/interview/engine-state";
import { handleEngineState, handleGateAuthorize, handleOffRecord, handleQuestionQueue } from "../../lib/server/interview/handlers";
import { interviewHooks, type InterviewDeps } from "../../lib/server/interview/orchestrator";
import type { TutorDeps } from "../../lib/server/tutor/deps";
import { handleIntent, handleJudgeCase, handlePractice, handlePrediction, handleTutorState, tutorHooks } from "../../lib/server/tutor/handlers";
import { createPracticeSolver } from "../../lib/server/tutor/solver";
import { T0, jsonRequest, type Reply } from "./casedesk-harness";

type RuleInput = z.input<typeof ConfirmedRuleSchema>;

/** A confirmed rule of the review family, quoting the expert verbatim; `frameIds` are filled in by `seedRules`. */
export function expertRule(input: {
  id: string;
  kind: RuleInput["kind"];
  effect: RuleInput["effect"];
  predicate: RuleInput["predicate"];
  quote: string;
  priority?: number;
  overrides?: string[];
}): ConfirmedRule {
  return ConfirmedRuleSchema.parse({
    id: input.id,
    decisionFamily: "reviewOutcome",
    kind: input.kind,
    predicate: input.predicate,
    effect: input.effect,
    priority: input.priority ?? 10,
    overrides: input.overrides ?? [],
    evidence: [
      {
        kind: "expert_quote",
        utteranceId: `utt-${input.id}`,
        exactQuote: input.quote,
        t0Ms: 1_000,
        t1Ms: 4_000,
        frameIds: ["placeholder"],
        eventIds: [],
        relation: "supports",
        provenance: "human_voice",
      },
    ],
    confirmedBy: [{ expertId: "expert-1", at: T0, method: "explicit_statement", ledgerEntryId: "confirm-1" }],
    revision: 1,
    schemaVersion: 1,
    expertId: "expert-1",
  });
}

const HIGH_NEW = { and: [{ "==": [{ var: "jurisdictionRisk" }, "high"] }, { "==": [{ var: "customerStatus" }, "new"] }] };

export const QUOTES = {
  enhanced: "A brand-new customer from a high-risk country always goes to enhanced review.",
  neverApprove: "Never approve a new customer from a high-risk country on the spot.",
  documents: "If the biggest owner holds more than 25% and we haven't verified them, ask for documents.",
  sanctions: "A sanctions match is never approved, full stop.",
} as const;

/** The plan §10 demo rulebook: a decision rule and a stop-rule for NS-2026-0201, a numeric rule, a sanctions stop-rule. */
export function demoRules(): ConfirmedRule[] {
  return [
    expertRule({ id: "rule-enhanced", kind: "decision", effect: { type: "recommend", action: "enhancedReview" }, predicate: HIGH_NEW, quote: QUOTES.enhanced }),
    expertRule({ id: "rule-never-approve", kind: "guardrail", effect: { type: "forbid", action: "approve" }, predicate: HIGH_NEW, quote: QUOTES.neverApprove }),
    expertRule({
      id: "rule-documents",
      kind: "decision",
      effect: { type: "recommend", action: "requestDocuments" },
      predicate: { and: [{ ">": [{ var: "uboOwnershipPct" }, 25] }, { "==": [{ var: "uboVerified" }, false] }] },
      quote: QUOTES.documents,
    }),
    expertRule({ id: "rule-sanctions", kind: "guardrail", effect: { type: "forbid", action: "approve" }, predicate: { "==": [{ var: "sanctionsHit" }, true] }, quote: QUOTES.sanctions }),
  ];
}

export type TutorHarness = {
  ledger: Ledger;
  authorizations: AuthorizationStore;
  tutor: TutorDeps;
  casedesk: CaseDeskDeps;
  interview: InterviewDeps;
  logs: string[];
  /** Records `rules` as confirmed in a new expert session (with a redacted frame on record); returns rule id → entry id. */
  seedRules: (rules: readonly ConfirmedRule[]) => Promise<Map<string, string>>;
  /** A novice session on `caseSet` (default held-out). */
  session: (caseSet?: "training" | "heldout" | "practice", mode?: "novice" | "expert") => Promise<string>;
  state: (sessionId: string) => Promise<Reply>;
  intent: (sessionId: string, caseId: string, action: string, edits?: Record<string, unknown>) => Promise<Reply>;
  predict: (sessionId: string, caseId: string, predicted: string, edits?: Record<string, unknown>) => Promise<Reply>;
  practice: (sessionId: string) => Promise<Reply>;
  judge: (sessionId: string, features: Record<string, unknown>) => Promise<Reply>;
  listCases: (query: string) => Promise<Reply>;
  /** Save: interlock check then commit (with `override` when given). */
  save: (sessionId: string, caseId: string, action: string, opts?: { edits?: Record<string, unknown>; override?: { kind: "acknowledged" | "escalated"; note: string } }) => Promise<{ check: Reply; commit: Reply }>;
  /** Posts DOM events at the next frame numbers. */
  events: (sessionId: string, events: Record<string, unknown>[]) => Promise<Reply>;
  offRecord: (sessionId: string, offRecord: boolean) => Promise<Reply>;
  questions: (sessionId: string) => Promise<Reply>;
  authorize: (sessionId: string, questionId: string, contextVersion: number) => Promise<Reply>;
  engine: (sessionId: string) => Promise<Reply>;
  entries: (sessionId: string, kinds?: string[]) => LedgerEntry[];
  epoch: (sessionId: string) => number;
};

async function reply(response: Response): Promise<Reply> {
  return { status: response.status, body: await response.json() };
}

export function createTutorHarness(): TutorHarness {
  const opened = openDatabase({ memory: true });
  const ledger = createLedger(opened.db);
  const now = () => T0;
  const authorizations = createAuthorizationStore({ now });
  const logs: string[] = [];
  const capture = (...args: unknown[]) => void logs.push(args.map(String).join(" "));
  const log = { info: capture, warn: capture, error: capture };
  const rulebook = createLedgerRulebook(opened.sqlite);
  const store = createCaseDeskStore();
  const tutor: TutorDeps = { ledger, casedesk: store, rulebook, authorizations, practice: createPracticeSolver(), now, log };
  const interview: InterviewDeps = { ledger, casedesk: store, store: createInterviewStore(), authorizations, claude: null, config: engineConfig(), now, log };
  const casedesk: CaseDeskDeps = {
    ledger,
    store,
    rulebook: () => rulebook().rules,
    interview: interviewHooks(interview),
    tutor: tutorHooks(tutor),
    now,
    log,
  };
  const frameSeqs = new Map<string, number>();
  const epoch = (sessionId: string): number => ledger.getSession(sessionId)?.privacyEpoch ?? -1;
  const createSession = async (mode: "novice" | "expert", caseSet: string): Promise<string> => {
    const r = await reply(await handleCreateSession(jsonRequest("/api/sessions", { mode, caseSet }), casedesk));
    expect(r.status).toBe(201);
    return (r.body as { sessionId: string }).sessionId;
  };

  const h: TutorHarness = {
    ledger,
    authorizations,
    tutor,
    casedesk,
    interview,
    logs,
    seedRules: async (rules) => {
      const expertSession = await createSession("expert", "training");
      const frame = ledger.append({
        sessionId: expertSession,
        source: "client",
        kind: "frame.received",
        occurredAt: T0,
        traceId: randomUUID(),
        parentIds: [],
        schemaVersion: 1,
        privacyEpoch: epoch(expertSession),
        payload: { frameId: randomUUID(), frameSeq: 1, captureTime: T0, width: 1568, height: 882, mediaPath: "frames/x.png", redactedRegions: 0, changeScore: 0.4 },
      });
      const ids = new Map<string, string>();
      for (const rule of rules) {
        const [quote, ...rest] = rule.evidence;
        const withFrame = ConfirmedRuleSchema.parse({ ...rule, evidence: [{ ...quote, frameIds: [frame.id] }, ...rest] });
        const written = ledger.append({
          sessionId: expertSession,
          source: "expert",
          kind: "rule.confirmed",
          occurredAt: T0,
          traceId: randomUUID(),
          parentIds: [frame.id],
          schemaVersion: 1,
          privacyEpoch: epoch(expertSession),
          payload: { rule: withFrame },
        });
        ids.set(rule.id, written.id);
      }
      return ids;
    },
    session: (caseSet = "heldout", mode = "novice") => createSession(mode, caseSet),
    state: async (sessionId) => reply(await handleTutorState(sessionId, tutor)),
    intent: async (sessionId, caseId, action, edits = {}) =>
      reply(await handleIntent(jsonRequest(`/api/sessions/${sessionId}/tutor/intent`, { caseId, proposedAction: action, edits }), sessionId, tutor)),
    predict: async (sessionId, caseId, predicted, edits = {}) =>
      reply(await handlePrediction(jsonRequest(`/api/sessions/${sessionId}/tutor/prediction`, { caseId, predicted, edits }), sessionId, tutor)),
    practice: async (sessionId) => reply(await handlePractice(sessionId, tutor)),
    judge: async (sessionId, features) =>
      reply(await handleJudgeCase(jsonRequest(`/api/sessions/${sessionId}/tutor/cases`, { features }), sessionId, tutor)),
    listCases: async (query) => reply(await handleListCases(new Request(`http://localhost/api/cases${query}`), casedesk)),
    save: async (sessionId, caseId, action, opts = {}) => {
      const edits = opts.edits ?? {};
      const check = await reply(await handleInterlockCheck(jsonRequest("/api/interlock/check", { sessionId, caseId, edits, proposedAction: action }), casedesk));
      if (check.status !== 200) return { check, commit: check };
      const checkId = (check.body as { checkId: string }).checkId;
      const body = { caseId, edits, action, checkId, ...(opts.override && { override: opts.override }) };
      const commit = await reply(await handleCommitDecision(jsonRequest(`/api/sessions/${sessionId}/decisions`, body), sessionId, casedesk));
      return { check, commit };
    },
    events: async (sessionId, events) => {
      const stamped = events.map((e) => {
        const seq = (frameSeqs.get(sessionId) ?? 0) + 1;
        frameSeqs.set(sessionId, seq);
        return { id: randomUUID(), frameSeq: seq, captureTime: T0, sessionEpoch: epoch(sessionId), confidence: 1, source: "dom", critical: false, ...e };
      });
      return reply(await handlePostEvents(jsonRequest(`/api/sessions/${sessionId}/events`, { events: stamped }), sessionId, casedesk));
    },
    offRecord: async (sessionId, offRecord) =>
      reply(await handleOffRecord(jsonRequest(`/api/sessions/${sessionId}/off-record`, { offRecord }), sessionId, interview)),
    questions: async (sessionId) => reply(await handleQuestionQueue(sessionId, interview)),
    authorize: async (sessionId, questionId, contextVersion) =>
      reply(
        await handleGateAuthorize(
          jsonRequest(`/api/sessions/${sessionId}/gate/authorize`, {
            questionId,
            contextVersion,
            becameValidAt: T0 - 20,
            decidedAt: T0 - 10,
            conditions: { notOffRecord: true, agentIdle: true },
          }),
          sessionId,
          interview,
        ),
      ),
    engine: async (sessionId) => reply(await handleEngineState(sessionId, interview)),
    entries: (sessionId, kinds) => ledger.list(sessionId, kinds === undefined ? {} : { kinds }).map((e) => LedgerEntrySchema.parse(e)),
    epoch,
  };
  return h;
}
