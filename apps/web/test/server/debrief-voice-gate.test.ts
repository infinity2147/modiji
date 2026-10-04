/**
 * The debrief page's voice loop end to end, without ElevenLabs: the REAL conversation bridge and browser gate,
 * wired as `useInterviewLoop` wires them for the debrief (`debrief_turn` only, no screen), against the REAL
 * question queue, gate-authorize, utterance and custom-LLM handlers of a session whose debrief has started. The
 * fake "agent" passes each control message to the custom LLM and says exactly the text it streams back.
 *
 * Regression (production): the turn is already waiting when Talk connects, so the gate authorised it and sent
 * its control message the instant the SDK reported `onConnect`. Over WebRTC that is before the agent has
 * initialised the conversation, and the message never reached the agent's LLM: the interviewer listened and
 * never spoke. The gate now waits for the agent's `conversation_initiation_metadata` (`bridge.initialised`).
 */
import { rm } from "node:fs/promises";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { engineConfig, parseLedgerPayload, type QuestionKind } from "@vashistha/core";
import { DebriefConversationSchema, type DebriefConversation } from "../../lib/contracts/debrief";
import { createGateSession, QUEUE_POLL_MS } from "../../lib/client/gate/gate-session";
import { createConversationBridge } from "../../lib/client/voice/bridge";
import { createAuthorizationStore } from "../../lib/server/authorizations";
import { handleChatCompletion } from "../../lib/server/custom-llm";
import { conversationView, replyBySpeech, type ConversationDeps } from "../../lib/server/debrief/conversation";
import { handleConversation } from "../../lib/server/debrief/handlers";
import { handleGateAuthorize, handlePostAgentUtterance, handlePostUtterance, handleQuestionQueue } from "../../lib/server/interview/handlers";
import type { InterviewDeps } from "../../lib/server/interview/orchestrator";
import { createSchemaStore } from "../../lib/server/schema/deps";
import { jsonRequest } from "../support/casedesk-harness";
import { T0, path, reply, world, type World } from "../support/debrief-harness";
import { inProcessQuestions } from "../support/engine";
import { SECRET, chatBody, chatRequest, readTurn } from "../support/llm-harness";
import { scriptedFetch, tick } from "../client/fake-fetch";
import { manualClock } from "../client/interview-support";

/** What the debrief page's voice loop speaks (components/debrief/debrief-voice.tsx). */
const DEBRIEF_KINDS: ReadonlySet<QuestionKind> = new Set(["debrief_turn"]);

let w: World;
let conversation: ConversationDeps;
let voice: InterviewDeps;
let time: ReturnType<typeof manualClock>;
let authorizations: ReturnType<typeof createAuthorizationStore>;

beforeEach(async () => {
  w = await world();
  // No model: the conversation reads yes / no / skip by code.
  w.deps.claude = null;
  const log = { info: () => undefined, warn: () => undefined, error: (...a: unknown[]) => console.error(...a) };
  w.deps.log = log;
  time = manualClock(T0);
  authorizations = createAuthorizationStore({ now: time.now });
  w.deps.authorizations = authorizations;
  conversation = {
    debrief: w.deps,
    schema: { ledger: w.ledger, casedesk: w.deps.casedesk, interview: w.deps.interview, engineConfig: engineConfig(), reread: null, store: createSchemaStore(), now: () => T0, log },
  };
  // The interview's dependencies over the same ledger and stores, as the runtime wires them (interview/deps.ts).
  voice = {
    ledger: w.ledger,
    casedesk: w.deps.casedesk,
    store: w.deps.interview,
    authorizations,
    claude: null,
    config: engineConfig(),
    questions: inProcessQuestions,
    rulebook: w.deps.rulebook,
    now: time.now,
    schedule: (fn, delayMs) => time.clock.setTimer(fn, delayMs),
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

/** The debrief page's voice loop: bridge + gate as `useInterviewLoop` creates them, over the real handlers. */
function debriefVoiceLoop() {
  const authorizeStatus: number[] = [];
  const net = scriptedFetch(async (url, body) => {
    const route = url.replace(/^.*\/api\/sessions\/[^/]+\//, "");
    const sessionId = w.sessionId;
    if (route === "questions") return handleQuestionQueue(sessionId, voice);
    if (route === "gate/authorize") {
      const r = await handleGateAuthorize(jsonRequest(url, body), sessionId, voice);
      authorizeStatus.push(r.status);
      return r;
    }
    if (route === "utterances") return handlePostUtterance(jsonRequest(url, body), sessionId, voice);
    if (route === "agent-utterances") return handlePostAgentUtterance(jsonRequest(url, body), sessionId, voice);
    throw new Error(`unexpected request ${url}`);
  });
  /** What the agent said: exactly what the custom LLM streamed for each control message. */
  const spoken: string[] = [];
  const llmSkips: string[] = [];
  const agentTurns: Promise<void>[] = [];

  // The bridge and the gate call each other only from callbacks, after both exist (as in use-interview.ts).
  const bridge = createConversationBridge({
    sessionId: w.sessionId,
    fetch: net.fetch,
    now: time.now,
    gate: {
      vad: (score) => gate.vad(score),
      localSpeech: (speaking) => gate.localSpeech(speaking),
      transcript: (final) => gate.transcript(final),
      agentSpeaking: (speaking) => gate.agentSpeaking(speaking),
      setVoiceLive: (live) => gate.setVoiceLive(live),
    },
    privacy: () => ({ offRecord: false, epoch: 0 }),
    vadThreshold: 0.4,
    onOffRecordPhrase: () => undefined,
  });
  /** ElevenLabs hands the control message to the custom LLM; the agent says what it streams, or skips. */
  const agentTurn = async (controlMessage: string): Promise<void> => {
    const response = await handleChatCompletion(
      chatRequest(chatBody({ model: "vashistha-interviewer-v3", messages: [{ role: "user", content: controlMessage }], extraBody: { sessionId: w.sessionId } }), {
        authorization: `Bearer ${SECRET}`,
      }),
      { secret: SECRET, authorizations, ledger: w.ledger, now: time.now, log: voice.log },
      performance.now(),
    );
    const turn = await readTurn(response);
    if (turn.kind !== "speech") {
      llmSkips.push(turn.kind === "skip" ? turn.reason : turn.kind);
      return;
    }
    spoken.push(turn.text);
    bridge.mode("speaking");
    bridge.message({ role: "agent", message: turn.text });
  };
  const gate = createGateSession({
    sessionId: w.sessionId,
    mode: "interviewer",
    fetch: net.fetch,
    clock: time.clock,
    sendControlMessage: (text) => void agentTurns.push(agentTurn(text)),
    holdAgent: () => undefined,
    onAsked: (asked) => bridge.asked(asked.questionId),
    questionKinds: DEBRIEF_KINDS,
  });

  /** Lets every pending request, agent turn and server task settle. */
  const settle = async (): Promise<void> => {
    for (let i = 0; i < 5; i += 1) {
      await tick();
      await Promise.all(agentTurns);
    }
  };
  /** Advances the clock in poll-sized steps, settling after each. */
  const run = async (ms: number): Promise<void> => {
    for (let elapsed = 0; elapsed < ms; elapsed += QUEUE_POLL_MS) {
      time.advance(Math.min(QUEUE_POLL_MS, ms - elapsed));
      await settle();
    }
  };
  /** The agent's audio ends `ms` after it began. */
  const finishSpeaking = async (ms = 2500): Promise<void> => {
    await run(ms);
    bridge.mode("listening");
    await settle();
  };
  const authorizeCalls = () => net.requests.filter((r) => r.url.endsWith("/gate/authorize"));
  return { bridge, gate, net, spoken, llmSkips, authorizeStatus, authorizeCalls, settle, run, finishSpeaking };
}

const waitingText = async (): Promise<string | undefined> => (await conversationView(conversation, w.sessionId)).awaiting?.text;

describe("debrief voice: the interviewer speaks the conversation's turns", () => {
  it("waits for the agent to initialise the conversation, then says the waiting turn without the expert speaking first", async () => {
    const started = await post({ type: "start" });
    const first = started.awaiting?.text;
    expect(first).toMatch(/^Let's go over what I learned/);
    const v = debriefVoiceLoop();
    await v.settle();
    expect(v.gate.snapshot().queue.map((q) => q.text)).toEqual([first]);

    // Talk: the SDK reports onConnect before the agent has initialised the conversation. Nothing may be sent yet.
    v.bridge.connected("conv-debrief");
    await v.run(3000);
    expect(v.authorizeCalls()).toEqual([]);
    expect(v.spoken).toEqual([]);

    // The agent's conversation_initiation_metadata: the waiting turn is authorised and said at once, exactly.
    v.bridge.initialised();
    await v.settle();
    expect(v.authorizeStatus).toEqual([200]);
    expect(v.llmSkips).toEqual([]);
    expect(v.spoken).toEqual([first]);
    const authorized = w.ledger.list(w.sessionId, { kinds: ["gate.authorized"] });
    expect(authorized).toHaveLength(1);
    const questionId = authorized[0] === undefined ? "" : parseLedgerPayload(authorized[0], "gate.authorized").questionId;
    const queued = w.ledger.list(w.sessionId, { kinds: ["question.queued"] }).map((e) => parseLedgerPayload(e, "question.queued")).find((q) => q.id === questionId);
    expect(queued).toMatchObject({ kind: "debrief_turn", text: first });
    v.gate.dispose();
  }, 60_000);

  it("after a spoken reply and after a typed reply, the next turn is spoken", async () => {
    await post({ type: "start" });
    const v = debriefVoiceLoop();
    await v.settle();
    v.bridge.connected("conv-debrief");
    v.bridge.initialised();
    await v.settle();
    expect(v.spoken).toHaveLength(1);
    const first = v.spoken[0];
    await v.finishSpeaking();

    // A spoken "skip": the expert talks, the provider transcribes it, the server hands it to the conversation.
    await v.run(1000);
    v.bridge.vad(0.9);
    await v.run(700);
    v.bridge.vad(0.02);
    v.bridge.message({ role: "user", message: "Skip" });
    await v.settle();
    // The server's answer window closes, the conversation reads the reply and asks the next turn.
    await v.run(2000);
    const second = await waitingText();
    expect(second).toBeDefined();
    expect(second).not.toBe(first);
    expect((await conversationView(conversation, w.sessionId)).turns.filter((t) => t.role === "expert").at(-1)).toMatchObject({ text: "Skip", via: "voice" });
    // The gate gives the expert's answer its silence, then the agent says the next turn.
    await vi.waitFor(async () => {
      await v.run(1000);
      expect(v.spoken).toEqual([first, second]);
    });
    await v.finishSpeaking();

    // A typed reply (the chat's Send: typing, then the reply, then `sensors.committed()`).
    v.gate.typing();
    await v.run(500);
    const third = (await post({ type: "reply", text: "Skip" })).awaiting?.text;
    v.gate.committed();
    expect(third).toBeDefined();
    expect(third).not.toBe(second);
    await vi.waitFor(async () => {
      await v.run(1000);
      expect(v.spoken).toEqual([first, second, third]);
    });
    expect(v.llmSkips).toEqual([]);
    expect(v.authorizeStatus).toEqual([200, 200, 200]);
    v.gate.dispose();
  }, 60_000);
});
