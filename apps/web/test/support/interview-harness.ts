/**
 * Shared setup for the interview tests: in-memory ledger, CaseDesk handlers wired to the real interview
 * hooks, a fake clock for the nonce store, the custom-LLM handler on the same ledger and nonce store,
 * and a fake Anthropic client behind the real `createClaude` wrapper (so the oracle prompt guard and
 * structured-output validation run exactly as in production).
 */
import { expect } from "vitest";
import {
  ANSWER_PARSER_SYSTEM,
  CONCEPT_PROPOSER_SYSTEM,
  LOCALIZER_SYSTEM,
  REPHRASER_SYSTEM,
  TRANSLATOR_SYSTEM,
  engineConfig,
  type ExpertLanguage,
  type LedgerEntry,
  type LlmAnswer,
  type LlmConceptProposal,
  type LlmLocalizedQuestion,
  type LlmRephrase,
  type LlmTranslation,
  type ParsedAnswer,
  parseLedgerPayload,
} from "@vashistha/core";
import { createClaude, createLedger, openDatabase, type ClaudeClient, type Ledger } from "@vashistha/core/server";
import { kycCases, type KycCase } from "@vashistha/core/domains/kyc";
import { ORACLE_MARKER } from "@vashistha/core/domains/kyc/oracle";
import { createAuthorizationStore, type AuthorizationStore } from "../../lib/server/authorizations";
import { handleCommitDecision, handleInterlockCheck } from "../../lib/server/casedesk/interlock";
import { handlePostEvents } from "../../lib/server/casedesk/events";
import { handleCreateSession } from "../../lib/server/casedesk/sessions";
import { createCaseDeskStore, type CaseDeskDeps } from "../../lib/server/casedesk/session";
import { handleChatCompletion } from "../../lib/server/custom-llm";
import { createInterviewStore } from "../../lib/server/interview/engine-state";
import {
  handleEngineState,
  handleGateAuthorize,
  handleOffRecord,
  handlePostAgentUtterance,
  handlePostUtterance,
  handleQuestionQueue,
} from "../../lib/server/interview/handlers";
import { createLedgerRulebook } from "../../lib/server/debrief/rulebook-store";
import { closeAnswer, interviewHooks, interviewIdle, type InterviewDeps } from "../../lib/server/interview/orchestrator";
import { inProcessQuestions } from "./engine";
import { NO_TUTOR, T0, domEvent, jsonRequest, type Reply } from "./casedesk-harness";
import { SECRET, chatBody, chatRequest } from "./llm-harness";

type Message = Awaited<ReturnType<ClaudeClient["messages"]["create"]>>;
type CreateParams = Parameters<ClaudeClient["messages"]["create"]>[0];

/** What the fake model answers, per prompt family. Unset ⇒ the call fails (as an outage would). */
export type FakeModel = {
  answer?: (user: string) => LlmAnswer;
  concepts?: (user: string) => LlmConceptProposal;
  /** Default: echo the template text and target feature (accepted unchanged). */
  rephrase?: (user: string) => LlmRephrase;
  /** Utterance translation (non-English answers, plan §7.11). */
  translate?: (user: string) => LlmTranslation;
  /** Questions in the expert's language (plan §7.11). */
  localize?: (user: string) => LlmLocalizedQuestion;
};

export type ModelCall = { kind: "answer" | "concepts" | "rephrase" | "translate" | "localize"; system: string; user: string };

const PROMPT_KINDS: readonly [string, ModelCall["kind"]][] = [
  [ANSWER_PARSER_SYSTEM, "answer"],
  [CONCEPT_PROPOSER_SYSTEM, "concepts"],
  [REPHRASER_SYSTEM, "rephrase"],
  [TRANSLATOR_SYSTEM, "translate"],
  [LOCALIZER_SYSTEM, "localize"],
];

function message(text: string): Message {
  return {
    id: "msg_fake",
    container: null,
    content: [{ type: "text", text, citations: null }],
    diagnostics: null,
    model: "claude-sonnet-5-5",
    role: "assistant",
    stop_details: null,
    stop_reason: "end_turn",
    stop_sequence: null,
    type: "message",
    usage: {
      cache_creation: null,
      cache_creation_input_tokens: 0,
      cache_read_input_tokens: 0,
      inference_geo: null,
      input_tokens: 100,
      output_tokens: 40,
      output_tokens_details: null,
      server_tool_use: null,
      service_tier: "standard",
    },
  };
}

function textOf(params: CreateParams): { system: string; user: string } {
  const system = typeof params.system === "string" ? params.system : (params.system ?? []).map((b) => b.text).join("");
  const content = params.messages[0]?.content;
  return { system, user: typeof content === "string" ? content : JSON.stringify(content) };
}

export function echoRephrase(user: string): LlmRephrase {
  const text = /<question kind="[a-z_]+">([\s\S]*?)<\/question>/.exec(user)?.[1] ?? "";
  const target = /<target_feature>(.*?)<\/target_feature>/.exec(user)?.[1] ?? "null";
  return { text, targetFeature: target === "null" ? null : target };
}

function fakeClient(model: FakeModel, calls: ModelCall[]): ClaudeClient {
  return {
    messages: {
      create: (params) => {
        const { system, user } = textOf(params);
        const kind = PROMPT_KINDS.find(([prefix]) => system.startsWith(prefix))?.[1];
        if (kind === undefined) return Promise.reject(new Error("unexpected prompt"));
        calls.push({ kind, system, user });
        const responders: Record<ModelCall["kind"], ((user: string) => unknown) | undefined> = {
          answer: model.answer,
          concepts: model.concepts,
          rephrase: model.rephrase ?? echoRephrase,
          translate: model.translate,
          localize: model.localize,
        };
        const respond = responders[kind];
        if (respond === undefined) return Promise.reject(new Error(`no fake ${kind} response configured`));
        return Promise.resolve(message(JSON.stringify(respond(user))));
      },
    },
  };
}

export type InterviewHarness = {
  ledger: Ledger;
  authorizations: AuthorizationStore;
  deps: InterviewDeps;
  casedesk: CaseDeskDeps;
  logs: string[];
  modelCalls: ModelCall[];
  /** Installs a fake model (null: no ANTHROPIC key). */
  setModel: (model: FakeModel | null) => void;
  /** Moves the clock on, firing the timers (answer windows) that fall due. */
  advance: (ms: number) => void;
  /** Closes the session's open answer (as the next agent turn would) and waits for its parse. */
  closeAnswer: (sessionId: string) => Promise<void>;
  /** Simulates a process restart: in-memory interview and CaseDesk state are lost, the ledger is not. */
  restart: () => void;
  /** Creates a session; an expert session may name its expert and their language (plan §7.10–7.11). */
  session: (mode: "expert" | "novice", expert?: { name: string; language: ExpertLanguage }) => Promise<string>;
  /** Opens the case, sets the risk rating, checks and commits `action`; waits for the engine step. */
  work: (sessionId: string, caseId: string, action: string, riskRating?: "low" | "medium" | "high") => Promise<string>;
  /** Appends a `client` / `frame.received` entry (what perception will upload). */
  frame: (sessionId: string) => LedgerEntry;
  idle: (sessionId: string) => Promise<void>;
  questions: (sessionId: string) => Promise<Reply>;
  authorize: (sessionId: string, body: unknown) => Promise<Reply>;
  utter: (sessionId: string, body: unknown) => Promise<Reply>;
  /**
   * Posts an utterance that answers an asked question, closes the answer window (as the agent's next
   * turn would) and returns the reply with the answer the engine parsed from it, if any.
   */
  answerWith: (sessionId: string, body: unknown) => Promise<Reply & { parsed: ParsedAnswer | undefined }>;
  agentSaid: (sessionId: string, body: unknown) => Promise<{ status: number }>;
  offRecord: (sessionId: string, offRecord: boolean) => Promise<Reply>;
  engine: (sessionId: string) => Promise<Reply>;
  /** One ElevenLabs custom-LLM turn whose last user message is `text`, in `sessionId`. */
  llmTurn: (sessionId: string, text: string, model?: string) => Promise<Response>;
  epoch: (sessionId: string) => number;
};

async function reply(response: Response): Promise<Reply> {
  return { status: response.status, body: await response.json() };
}

export function createInterviewHarness(): InterviewHarness {
  const opened = openDatabase({ memory: true });
  const ledger = createLedger(opened.db);
  let clock = T0;
  const now = () => clock;
  const authorizations = createAuthorizationStore({ now });
  const logs: string[] = [];
  const capture = (...args: unknown[]) => void logs.push(args.map(String).join(" "));
  const log = { info: capture, warn: capture, error: capture };
  const modelCalls: ModelCall[] = [];
  const frameSeqs = new Map<string, number>();
  let frames = 0;
  const timers: { at: number; fn: () => void; live: boolean }[] = [];
  const schedule = (fn: () => void, delayMs: number): (() => void) => {
    const timer = { at: clock + delayMs, fn, live: true };
    timers.push(timer);
    return () => {
      timer.live = false;
    };
  };

  const deps: InterviewDeps = {
    ledger,
    casedesk: createCaseDeskStore(),
    store: createInterviewStore(),
    authorizations,
    claude: null,
    config: engineConfig(),
    questions: inProcessQuestions,
    rulebook: createLedgerRulebook(opened.sqlite),
    now,
    schedule,
    log,
  };
  const casedesk: CaseDeskDeps = {
    ledger,
    store: deps.casedesk,
    rulebook: () => [],
    interview: interviewHooks(deps),
    tutor: NO_TUTOR,
    now,
    log,
  };
  const epoch = (sessionId: string): number => ledger.getSession(sessionId)?.privacyEpoch ?? -1;
  const post = async (sessionId: string, events: Record<string, unknown>[]): Promise<void> => {
    const r = await reply(await handlePostEvents(jsonRequest(`/api/sessions/${sessionId}/events`, { events }), sessionId, casedesk));
    expect(r.status, JSON.stringify(r.body)).toBe(200);
  };
  const nextSeq = (sessionId: string): number => {
    const seq = (frameSeqs.get(sessionId) ?? 0) + 1;
    frameSeqs.set(sessionId, seq);
    return seq;
  };

  const h: InterviewHarness = {
    ledger,
    authorizations,
    deps,
    casedesk,
    logs,
    modelCalls,
    setModel: (model) => {
      deps.claude = model === null ? null : createClaude({ client: fakeClient(model, modelCalls), forbiddenMarkers: [ORACLE_MARKER] });
    },
    advance: (ms) => {
      clock += ms;
      for (const timer of timers.filter((t) => t.live && t.at <= clock).sort((a, b) => a.at - b.at)) {
        timer.live = false;
        timer.fn();
      }
    },
    closeAnswer: (sessionId) => closeAnswer(deps, sessionId),
    restart: () => {
      deps.store = createInterviewStore();
      deps.casedesk = createCaseDeskStore();
      casedesk.store = deps.casedesk;
      casedesk.interview = interviewHooks(deps);
    },
    session: async (mode, expert) => {
      const r = await reply(await handleCreateSession(jsonRequest("/api/sessions", { mode, caseSet: "training", ...(expert && { expert }) }), casedesk));
      expect(r.status).toBe(201);
      return (r.body as { sessionId: string }).sessionId;
    },
    work: async (sessionId, caseId, action, riskRating) => {
      const sessionEpoch = epoch(sessionId);
      await post(sessionId, [domEvent({ frameSeq: nextSeq(sessionId), kind: "open_case", caseId, sessionEpoch })]);
      if (riskRating !== undefined)
        await post(sessionId, [
          domEvent({ frameSeq: nextSeq(sessionId), kind: "field_change", caseId, field: "riskRating", from: "unrated", to: riskRating, sessionEpoch }),
        ]);
      const edits = riskRating === undefined ? {} : { riskRating };
      const check = await reply(await handleInterlockCheck(jsonRequest("/api/interlock/check", { sessionId, caseId, edits, proposedAction: action }), casedesk));
      expect(check.status).toBe(200);
      const checkId = (check.body as { checkId: string }).checkId;
      const decided = await reply(
        await handleCommitDecision(jsonRequest(`/api/sessions/${sessionId}/decisions`, { caseId, edits, action, checkId }), sessionId, casedesk),
      );
      expect(decided.status, JSON.stringify(decided.body)).toBe(200);
      await interviewIdle(deps.store, sessionId);
      return (decided.body as { decisionId: string }).decisionId;
    },
    frame: (sessionId) => {
      frames += 1;
      return ledger.append({
        sessionId,
        source: "client",
        kind: "frame.received",
        occurredAt: clock,
        traceId: `trace-frame-${frames}`,
        parentIds: [],
        schemaVersion: 1,
        privacyEpoch: epoch(sessionId),
        payload: {
          frameId: `frame-${frames}`,
          frameSeq: frames,
          captureTime: clock,
          width: 1568,
          height: 882,
          mediaPath: `frames/${sessionId}/${frames}.webp`,
          redactedRegions: 0,
          changeScore: 0.4,
        },
      });
    },
    idle: (sessionId) => interviewIdle(deps.store, sessionId),
    questions: async (sessionId) => reply(await handleQuestionQueue(sessionId, deps)),
    authorize: async (sessionId, body) => reply(await handleGateAuthorize(jsonRequest(`/api/sessions/${sessionId}/gate/authorize`, body), sessionId, deps)),
    utter: async (sessionId, body) => reply(await handlePostUtterance(jsonRequest(`/api/sessions/${sessionId}/utterances`, body), sessionId, deps)),
    answerWith: async (sessionId, body) => {
      const before = ledger.list(sessionId, { kinds: ["answer.parsed"] }).length;
      const r = await h.utter(sessionId, body);
      await closeAnswer(deps, sessionId);
      const parsed = ledger.list(sessionId, { kinds: ["answer.parsed"] }).slice(before).at(-1);
      return { ...r, parsed: parsed && parseLedgerPayload(parsed, "answer.parsed") };
    },
    agentSaid: async (sessionId, body) => ({
      status: (await handlePostAgentUtterance(jsonRequest(`/api/sessions/${sessionId}/agent-utterances`, body), sessionId, deps)).status,
    }),
    offRecord: async (sessionId, offRecord) => reply(await handleOffRecord(jsonRequest(`/api/sessions/${sessionId}/off-record`, { offRecord }), sessionId, deps)),
    engine: async (sessionId) => reply(await handleEngineState(sessionId, deps)),
    llmTurn: (sessionId, text, model = "vashistha-interviewer-v1") =>
      handleChatCompletion(
        chatRequest(chatBody({ model, messages: [{ role: "user", content: text }], extraBody: { sessionId } }), { authorization: `Bearer ${SECRET}` }),
        { secret: SECRET, authorizations, ledger, now, log },
        performance.now(),
      ),
    epoch,
  };
  return h;
}

/** A gate request for `questionId` at `contextVersion`, as the browser gate sends it. */
export function gateRequest(questionId: string, contextVersion: number): Record<string, unknown> {
  return {
    questionId,
    contextVersion,
    becameValidAt: T0 - 120,
    decidedAt: T0 - 100,
    conditions: { userSilent: true, screenIdle: true, typingIdle: true, atBreakpoint: true, valueAboveTheta: true, budget: true },
  };
}

/** An utterance body for the current epoch. */
export function utterance(h: InterviewHarness, sessionId: string, text: string, over: Record<string, unknown> = {}): Record<string, unknown> {
  return { conversationId: "conv-1", text, t0Ms: 10_000, t1Ms: 14_500, privacyEpoch: h.epoch(sessionId), ...over };
}

/** The three training cases of the plan §10 demo, in order. */
export function trainingCases(): [KycCase, KycCase, KycCase] {
  const [one, two, three] = kycCases("training");
  if (!one || !two || !three) throw new Error("the training set has fewer than three cases");
  return [one, two, three];
}
