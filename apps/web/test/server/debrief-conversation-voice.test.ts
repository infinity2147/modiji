/**
 * The debrief conversation by voice: a spoken reply to a debrief turn (a `debrief_turn` question the interviewer
 * spoke) is routed by the interview's utterance path to the conversation, never to the answer parser, over a short
 * answer window and without needing a model for a plain yes. Only the turn now waiting takes a spoken reply. A rule
 * saved after a read-back cites the utterance of the statement the expert made (`human_voice`, original words,
 * language fields), not the "yes" that confirmed it. Real ledger, real conversation, fake model.
 */
import { rm } from "node:fs/promises";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  ConfirmedRuleSchema,
  QuestionSchema,
  TRANSLATOR_SYSTEM,
  canonicalJson,
  contentId,
  engineConfig,
  parseLedgerPayload,
  type AnsweredUtterance,
  type LedgerEntry,
  type LlmAnswer,
  type LlmTranslation,
} from "@vashistha/core";
import { createClaude, type ClaudeClient } from "@vashistha/core/server";
import { ORACLE_MARKER } from "@vashistha/core/domains/kyc/oracle";
import { DebriefConversationSchema, type DebriefConversation } from "../../lib/contracts/debrief";
import { createAuthorizationStore } from "../../lib/server/authorizations";
import { GateAuthorizeResponseSchema, QuestionQueueResponseSchema } from "../../lib/contracts/interview";
import { replyBySpeech, type ConversationDeps } from "../../lib/server/debrief/conversation";
import { handleConversation } from "../../lib/server/debrief/handlers";
import type { LlmDebriefReply } from "../../lib/server/debrief/interpret";
import { TEACHBACK_SYSTEM } from "../../lib/server/debrief/teachback";
import { engineState, unparsedAnswers } from "../../lib/server/interview/engine-state";
import { entry } from "../../lib/server/interview/ledger";
import { DEBRIEF_ANSWER_WINDOW_MS, closeAnswer, recordUtterance, type InterviewDeps } from "../../lib/server/interview/orchestrator";
import { createSchemaStore } from "../../lib/server/schema/deps";
import { jsonRequest } from "../support/casedesk-harness";
import { OPUS_TEACHBACK, T0, message, path, reply, world, type World } from "../support/debrief-harness";
import { inProcessQuestions } from "../support/engine";
import { createInterviewHarness, gateRequest, trainingCases, utterance, type InterviewHarness } from "../support/interview-harness";
import { readTurn } from "../support/llm-harness";

const EMPTY: LlmDebriefReply = { kind: "unclear", combinator: "all", conditions: [], action: "", effect: "none", role: "", rule: "none", min: 0, max: 0, integer: false, ruleNumber: 0 };
const SANCTIONS = "Never approve anyone with a sanctions hit, full stop.";

// A Hindi hard stop, said in two clauses; its verified English is what the conversation reads.
const CLAUSE_1 = "अगर देश हाई-रिस्क लिस्ट पर है,";
const CLAUSE_2 = "तो मैं कभी अप्रूव नहीं करती।";
const HINDI = `${CLAUSE_1} ${CLAUSE_2}`;
const SEGMENTS = [
  { original: CLAUSE_1, english: "If the country is on the high-risk list," },
  { original: CLAUSE_2, english: "then I never approve." },
];
const ENGLISH = SEGMENTS.map((s) => s.english).join(" ");

/** What the fake model says each reply means: keyed by the text the conversation sends it (English for the Hindi reply). */
const READINGS: Record<string, LlmDebriefReply> = {
  [SANCTIONS]: { ...EMPTY, kind: "stop_rule", conditions: [{ feature: "sanctionsHit", op: "==", value: true }], action: "approve", effect: "forbid" },
  [ENGLISH]: { ...EMPTY, kind: "stop_rule", conditions: [{ feature: "jurisdictionRisk", op: "==", value: "high" }], action: "approve", effect: "forbid" },
};

/** Fake model: debrief readings, the teach-back, and the utterance translator (for the Hindi reply). */
function fakeModel(read: string[]): ClaudeClient {
  return {
    messages: {
      create: async (params) => {
        const system = typeof params.system === "string" ? params.system : (params.system ?? []).map((b) => b.text).join("");
        const user = params.messages.map((m) => (typeof m.content === "string" ? m.content : "")).join("");
        if (system === TEACHBACK_SYSTEM) return message(OPUS_TEACHBACK);
        if (system.startsWith(TRANSLATOR_SYSTEM)) {
          expect(user).toContain(HINDI);
          const translation: LlmTranslation = { segments: SEGMENTS };
          return message(JSON.stringify(translation));
        }
        if (system.startsWith("You read an expert's reply")) {
          const expertReply = (JSON.parse(user) as { expertReply: string }).expertReply;
          read.push(expertReply);
          return message(JSON.stringify(READINGS[expertReply] ?? EMPTY));
        }
        throw new Error("unexpected prompt");
      },
    },
  };
}

// ── The orchestrator's routing (interview harness, a spy conversation) ──

const [ONE] = trainingCases();

/** Queues a `debrief_turn` question (as the conversation does) and has the gate authorize it. */
async function askedDebriefTurn(h: InterviewHarness, s: string): Promise<string> {
  const ctx = { sessionId: s, occurredAt: T0, traceId: "debrief-turn", privacyEpoch: h.epoch(s) };
  const asked = h.ledger.append(entry(ctx, "debrief.asked", "engine", [], { promptId: "prompt-1", topic: "stop_rules", ref: "first", text: "Any hard stop?", pending: null }));
  const question = QuestionSchema.parse({
    id: contentId("q", canonicalJson({ s, debrief: "prompt-1" })),
    sessionId: s,
    kind: "debrief_turn",
    text: "Any hard stop?",
    target: { candidateIds: [] },
    value: 1,
    reason: "debrief conversation",
    ephemeral: true,
    createdAt: T0,
    contextVersion: h.authorizations.getContextVersion(s),
    parentIds: [asked.id],
  });
  h.ledger.append(entry(ctx, "question.queued", "engine", [asked.id], question));
  const granted = await h.authorize(s, gateRequest(question.id, h.authorizations.getContextVersion(s)));
  expect(granted.status, JSON.stringify(granted.body)).toBe(200);
  return question.id;
}

describe("spoken replies to debrief turns: routing", () => {
  it("goes to the conversation after a short window, without a model, and never to the answer parser", async () => {
    const h = createInterviewHarness();
    const handed: { sessionId: string; questionId: string; segments: AnsweredUtterance[] }[] = [];
    h.deps.debriefAnswer = async (input) => void handed.push(input);
    expect(h.deps.claude).toBeNull();
    const s = await h.session("expert");
    const questionId = await askedDebriefTurn(h, s);

    const r = await h.utter(s, utterance(h, s, "Yes", { questionId }));
    expect(r.status).toBe(200);
    h.advance(DEBRIEF_ANSWER_WINDOW_MS - 1);
    await h.idle(s);
    expect(handed).toEqual([]);
    h.advance(1);
    await vi.waitFor(() => expect(handed).toHaveLength(1));
    const [spoken] = handed;
    expect(spoken).toMatchObject({ sessionId: s, questionId, segments: [{ text: "Yes", language: "en" }] });
    expect(spoken?.segments[0]?.id).toBe(h.ledger.list(s, { kinds: ["utterance.transcript"] }).at(-1)?.id);
    expect(h.ledger.list(s, { kinds: ["answer.parsed"] })).toEqual([]);
    // The reply is the conversation's to read, not an answer waiting for the parser.
    expect(unparsedAnswers(engineState(h.deps, s))).toEqual([]);
  });

  it("a failing conversation is logged, never thrown into the utterance route", async () => {
    const h = createInterviewHarness();
    h.deps.debriefAnswer = () => Promise.reject(new Error("conversation down"));
    const s = await h.session("expert");
    const questionId = await askedDebriefTurn(h, s);
    expect((await h.utter(s, utterance(h, s, "Yes", { questionId }))).status).toBe(200);
    await h.closeAnswer(s);
    expect(h.logs.some((l) => l.includes("debrief reply") && l.includes("conversation down"))).toBe(true);
  });

  it("a live question's answer still goes to the answer parser, never to the conversation", async () => {
    const h = createInterviewHarness();
    const handed: unknown[] = [];
    h.deps.debriefAnswer = async (input) => void handed.push(input);
    const answer: LlmAnswer = { survivingCandidateIds: [], eliminatedCandidateIds: [], statedRules: [], newConcepts: [], answeredAction: null, confidence: 0.9 };
    h.setModel({ answer: () => answer });
    const s = await h.session("expert");
    await h.work(s, ONE.id, "enhancedReview", "medium");
    const { queue, contextVersion } = QuestionQueueResponseSchema.parse((await h.questions(s)).body);
    const question = queue.find((q) => q.kind === "why_probe");
    if (question === undefined) throw new Error("no why-probe queued");
    const granted = GateAuthorizeResponseSchema.parse((await h.authorize(s, gateRequest(question.id, contextVersion))).body);
    expect(await readTurn(await h.llmTurn(s, granted.controlMessage))).toMatchObject({ kind: "speech", text: question.text });
    const r = await h.answerWith(s, utterance(h, s, "Because the owner was not verified.", { questionId: question.id }));
    expect(r.parsed).toBeDefined();
    expect(h.modelCalls.some((c) => c.kind === "answer")).toBe(true);
    expect(handed).toEqual([]);
  });
});

// ── End to end: the real conversation behind the interview's utterance path ──

let w: World;
let conversation: ConversationDeps;
let voice: InterviewDeps;
let modelReads: string[];
let logs: string[];

beforeEach(async () => {
  w = await world();
  modelReads = [];
  logs = [];
  const capture = (...args: unknown[]) => void logs.push(args.map(String).join(" "));
  const log = { info: capture, warn: capture, error: capture };
  w.deps.log = log;
  w.deps.claude = createClaude({ client: fakeModel(modelReads), forbiddenMarkers: [ORACLE_MARKER] });
  conversation = {
    debrief: w.deps,
    schema: { ledger: w.ledger, casedesk: w.deps.casedesk, interview: w.deps.interview, engineConfig: engineConfig(), reread: null, store: createSchemaStore(), now: () => T0, log },
  };
  // The interview's dependencies over the same ledger and stores, as the runtime wires them (interview/deps.ts).
  const authorizations = createAuthorizationStore();
  w.deps.authorizations = authorizations;
  voice = {
    ledger: w.ledger,
    casedesk: w.deps.casedesk,
    store: w.deps.interview,
    authorizations,
    claude: w.deps.claude,
    config: engineConfig(),
    questions: inProcessQuestions,
    rulebook: w.deps.rulebook,
    now: () => T0,
    schedule: () => () => undefined,
    debriefAnswer: (input) => replyBySpeech(conversation, input),
    log,
  };
});

afterEach(async () => {
  w.opened.close();
  await rm(w.dataDir, { recursive: true, force: true });
});

async function post(body: unknown): Promise<DebriefConversation> {
  const r = await reply(await handleConversation(jsonRequest(path(w.sessionId, "debrief/conversation"), body), w.sessionId, conversation));
  if (r.status !== 200) throw new Error(`conversation failed: ${r.status} ${JSON.stringify(r.body)}`);
  return DebriefConversationSchema.parse(r.body);
}

const view = (): Promise<DebriefConversation> => post({ type: "start" });

/** Skips (typed) every question until one about `topic` is waiting. */
async function skipTo(topic: string): Promise<DebriefConversation> {
  let c = await post({ type: "start" });
  for (let i = 0; i < 40 && c.awaiting !== null && c.awaiting.topic !== topic; i += 1) c = await post({ type: "reply", text: "skip" });
  expect(c.awaiting?.topic).toBe(topic);
  return c;
}

/** The `debrief_turn` question queued for the turn now waiting, authorized by the gate (as the voice loop would). */
function authorizeWaitingTurn(): string {
  const queued = w.ledger.list(w.sessionId, { kinds: ["question.queued"] }).findLast((e) => parseLedgerPayload(e, "question.queued").kind === "debrief_turn");
  if (queued === undefined) throw new Error("no debrief turn queued");
  const questionId = parseLedgerPayload(queued, "question.queued").id;
  w.ledger.append({
    sessionId: w.sessionId,
    source: "engine",
    kind: "gate.authorized",
    occurredAt: T0,
    traceId: "voice",
    parentIds: [queued.id],
    schemaVersion: 1,
    privacyEpoch: 0,
    payload: { questionId, contextVersion: 0, becameValidAt: T0, decidedAt: T0, conditions: {} },
  });
  return questionId;
}

/** The expert says `text` in answer to `questionId`; the answer window closes (as the next agent turn would). */
async function speak(questionId: string, text: string, t0Ms = 20_000): Promise<LedgerEntry> {
  const r = await recordUtterance(voice, w.sessionId, { conversationId: "conv-debrief", text, t0Ms, t1Ms: t0Ms + 2_500, privacyEpoch: 0, questionId });
  await closeAnswer(voice, w.sessionId);
  const u = w.ledger.get(r.utteranceId);
  if (u === undefined) throw new Error("utterance not recorded");
  return u;
}

const kinds = (kind: string): LedgerEntry[] => w.ledger.list(w.sessionId, { kinds: [kind] });

describe("debrief conversation by voice", () => {
  it("a spoken hard stop is read back, and a spoken yes saves it citing the statement's utterance, in the expert's exact words", async () => {
    const before = (await skipTo("stop_rules")).state.rules.length;
    const statement = await speak(authorizeWaitingTurn(), SANCTIONS);
    let c = await view();
    expect(c.awaiting?.topic).toBe("readback");
    expect(c.turns.at(-2)).toMatchObject({ role: "expert", text: SANCTIONS, via: "voice", outcome: { readAs: "statement", byModel: true, saved: false } });
    expect(modelReads).toEqual([SANCTIONS]);
    const replied = kinds("debrief.replied").at(-1);
    expect(replied === undefined ? undefined : parseLedgerPayload(replied, "debrief.replied")).toMatchObject({ via: "voice", utteranceId: statement.id, text: SANCTIONS });
    expect(replied?.parentIds).toContain(statement.id);

    const yes = await speak(authorizeWaitingTurn(), "Yes", 30_000);
    c = await view();
    expect(c.state.rules).toHaveLength(before + 1);
    const saved = c.state.rules.find((r) => JSON.stringify(r.rule.predicate).includes("sanctionsHit"));
    const record = engineState(voice, w.sessionId).utterances.get(statement.id);
    expect(record?.frameIds.length).toBeGreaterThan(0);
    expect(saved?.rule.kind).toBe("guardrail");
    expect(saved?.rule.evidence[0]).toEqual({
      kind: "expert_quote",
      utteranceId: statement.id,
      exactQuote: SANCTIONS,
      t0Ms: 20_000,
      t1Ms: 22_500,
      frameIds: record?.frameIds,
      eventIds: [],
      relation: "supports",
      provenance: "human_voice",
    });
    expect(ConfirmedRuleSchema.parse(saved?.rule).evidence[0].utteranceId).not.toBe(yes.id);
    const said = kinds("expert.statement").at(-1);
    expect(said === undefined ? undefined : parseLedgerPayload(said, "expert.statement")).toMatchObject({ intent: "confirm_stop_rule", text: SANCTIONS, utteranceId: statement.id });
    expect(said?.parentIds).toContain(statement.id);
    expect(c.awaiting?.text).toMatch(/^Saved\. Any other hard stop\?/);
  });

  it("ignores a spoken reply to a turn that is no longer waiting", async () => {
    await skipTo("stop_rules");
    const stale = authorizeWaitingTurn();
    // The expert answers in the chat first; the next turn is asked.
    const typed = await post({ type: "reply", text: "No" });
    const replies = kinds("debrief.replied").length;
    await speak(stale, SANCTIONS);
    const c = await view();
    expect(kinds("debrief.replied")).toHaveLength(replies);
    expect(c.turns).toHaveLength(typed.turns.length);
    expect(c.awaiting?.promptId).toBe(typed.awaiting?.promptId);
    expect(modelReads).toEqual([]);
    expect(logs.some((l) => l.includes("stale"))).toBe(true);
  });

  it("without any model, a spoken plain yes confirms the teach-back, citing the yes", async () => {
    w.deps.claude = null;
    voice.claude = null;
    await skipTo("teach_back");
    const yes = await speak(authorizeWaitingTurn(), "Yes, exactly.");
    const c = await view();
    expect(c.state.teachBack?.confirmedEntryId).not.toBeNull();
    const said = kinds("expert.statement").at(-1);
    expect(said === undefined ? undefined : parseLedgerPayload(said, "expert.statement")).toMatchObject({ intent: "confirm_teachback", text: "Yes, exactly.", utteranceId: yes.id });
    expect(c.turns.filter((t) => t.role === "expert").at(-1)).toMatchObject({ via: "voice", outcome: { readAs: "yes", byModel: false, saved: true } });
  });

  it("a non-English statement is understood through its verified translation, and the quote keeps the original words", async () => {
    await skipTo("stop_rules");
    const statement = await speak(authorizeWaitingTurn(), HINDI);
    expect(kinds("utterance.translated")).toHaveLength(1);
    // The model read the English; the conversation records the expert's own words.
    expect(modelReads).toEqual([ENGLISH]);
    let c = await view();
    expect(c.awaiting?.topic).toBe("readback");
    expect(c.turns.at(-2)?.text).toBe(HINDI);

    await speak(authorizeWaitingTurn(), "Yes", 30_000);
    c = await view();
    const saved = c.state.rules.find((r) => JSON.stringify(r.rule.predicate).includes("jurisdictionRisk"));
    expect(saved?.rule.evidence[0]).toMatchObject({ utteranceId: statement.id, exactQuote: HINDI, provenance: "human_voice", language: "hi", translation: ENGLISH });
  });
});
