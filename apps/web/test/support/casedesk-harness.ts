/** Shared setup for the CaseDesk handler tests: in-memory ledger, swappable rulebook, JSON request helpers. */
import { PERMIT_ALL, harnessSessionRequest } from "./accounts";
import { randomUUID } from "node:crypto";
import type { z } from "zod";
import { ConfirmedRuleSchema, type ConfirmedRule } from "@vashistha/core";
import { createLedger, openDatabase, type Ledger, type OpenedDatabase } from "@vashistha/core/server";
import { kycCases, type KycCase } from "@vashistha/core/domains/kyc";
import { handleCommitDecision, handleInterlockCheck } from "../../lib/server/casedesk/interlock";
import { handleLedgerPage } from "../../lib/server/casedesk/ledger-page";
import { handleCreateSession, handleListCases } from "../../lib/server/casedesk/sessions";
import { handlePostEvents } from "../../lib/server/casedesk/events";
import { createCaseDeskStore, type CaseDeskDeps, type InterviewHooks, type TutorHooks } from "../../lib/server/casedesk/session";

export const T0 = 1_760_000_000_000;

/** CaseDesk handler tests do not exercise the interview engine (interview*.test.ts do). */
const NO_INTERVIEW: InterviewHooks = { decisionCommitted: () => undefined, screenChanged: () => undefined };
/** Nor the tutor (tutor*.test.ts do). */
export const NO_TUTOR: TutorHooks = { decisionCommitted: () => undefined, screenEvents: () => undefined };

export type Reply = { status: number; body: unknown };

export type CaseDeskHarness = {
  opened: OpenedDatabase;
  ledger: Ledger;
  deps: CaseDeskDeps;
  logs: string[];
  setRules: (rules: ConfirmedRule[]) => void;
  /** Simulates a process restart: the in-memory CaseDesk state is lost, the ledger is not. */
  restart: () => void;
  createSession: (body: unknown) => Promise<Reply>;
  /** Creates a session and returns its id (asserting success). */
  session: (caseSet?: "training" | "heldout" | "practice") => Promise<string>;
  listCases: (query: string) => Promise<Reply>;
  postEvents: (sessionId: string, body: unknown) => Promise<Reply>;
  check: (body: unknown) => Promise<Reply>;
  decide: (sessionId: string, body: unknown) => Promise<Reply>;
  readLedger: (sessionId: string, query?: string) => Promise<Reply>;
};

async function reply(response: Response): Promise<Reply> {
  return { status: response.status, body: await response.json() };
}

export function jsonRequest(path: string, body: unknown): Request {
  return new Request(`http://localhost${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
}

export function createCaseDeskHarness(): CaseDeskHarness {
  const opened = openDatabase({ memory: true });
  const ledger = createLedger(opened.db);
  let rules: ConfirmedRule[] = [];
  const logs: string[] = [];
  const deps: CaseDeskDeps = {
    ledger,
    store: createCaseDeskStore(),
    rulebook: () => rules,
    interview: NO_INTERVIEW,
    tutor: NO_TUTOR,
    now: () => T0,
    log: { error: (...args: unknown[]) => logs.push(args.map(String).join(" ")) },
  };
  const h: CaseDeskHarness = {
    opened,
    ledger,
    deps,
    logs,
    setRules: (next) => {
      rules = next;
    },
    restart: () => {
      deps.store = createCaseDeskStore();
    },
    createSession: async (raw) => {
      const { actor, body } = harnessSessionRequest(raw);
      return reply(await handleCreateSession(jsonRequest("/api/sessions", body), deps, actor, PERMIT_ALL));
    },
    session: async (caseSet = "training") => {
      const { status, body } = await h.createSession({ mode: "novice", caseSet });
      if (status !== 201) throw new Error(`session creation failed: ${status} ${JSON.stringify(body)}`);
      return (body as { sessionId: string }).sessionId;
    },
    listCases: async (query) => reply(await handleListCases(new Request(`http://localhost/api/cases${query}`), deps)),
    postEvents: async (sessionId, body) =>
      reply(await handlePostEvents(jsonRequest(`/api/sessions/${sessionId}/events`, body), sessionId, deps)),
    check: async (body) => reply(await handleInterlockCheck(jsonRequest("/api/interlock/check", body), deps)),
    decide: async (sessionId, body) =>
      reply(await handleCommitDecision(jsonRequest(`/api/sessions/${sessionId}/decisions`, body), sessionId, deps)),
    readLedger: async (sessionId, query = "") =>
      reply(
        await handleLedgerPage(new Request(`http://localhost/api/sessions/${sessionId}/ledger${query}`), sessionId, deps),
      ),
  };
  return h;
}

/** A training case whose opened risk rating is not `high` (so a `high` edit is a real change). */
export function trainingCase(): KycCase {
  const found = kycCases("training").find((c) => c.review.riskRating !== "high");
  if (!found) throw new Error("no suitable training case");
  return found;
}

export function heldoutCase(): KycCase {
  const [found] = kycCases("heldout");
  if (!found) throw new Error("no held-out case");
  return found;
}

/** A DOM screen event as the CaseDesk client sends it. */
export function domEvent(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: randomUUID(),
    frameSeq: 1,
    captureTime: T0,
    sessionEpoch: 0,
    kind: "open_case",
    caseId: trainingCase().id,
    confidence: 1,
    source: "dom",
    critical: false,
    ...over,
  };
}

type RuleInput = z.input<typeof ConfirmedRuleSchema>;

export const EXPERT_QUOTE = "Never approve anyone we've rated high risk without a second look.";

/** A schema-valid confirmed rule backed by a supporting expert quote. */
export function confirmedRule(id: string, effect: RuleInput["effect"], predicate: RuleInput["predicate"]): ConfirmedRule {
  return ConfirmedRuleSchema.parse({
    id,
    decisionFamily: "reviewOutcome",
    kind: effect.type === "forbid" ? "guardrail" : "escalation",
    predicate,
    effect,
    priority: 10,
    overrides: [],
    evidence: [
      {
        kind: "expert_quote",
        utteranceId: `utt-${id}`,
        exactQuote: EXPERT_QUOTE,
        t0Ms: 1_000,
        t1Ms: 4_000,
        frameIds: ["frame-1"],
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

/** Forbids approving a case rated high; requires approval for any outcome on a case rated medium. */
export function fixtureRulebook(): ConfirmedRule[] {
  return [
    confirmedRule("rule.high.no-approve", { type: "forbid", action: "approve" }, {
      "==": [{ var: "riskRating" }, "high"],
    }),
    confirmedRule("rule.medium.approval", { type: "require_approval", role: "senior_reviewer" }, {
      "==": [{ var: "riskRating" }, "medium"],
    }),
  ];
}
