/**
 * The trainee's voice coach on the client: the tutor gate answers once the trainee pauses (not blocked by screen
 * motion or typing) and reads the queue fast while a reply is due; the browser voice reads new coach turns once
 * when no agent is connected; the idle nudge fires once per case; the caption strip and the coach's state.
 */
import { describe, expect, it } from "vitest";
import type { Question } from "@vashistha/core";
import { createGateSession, QUEUE_POLL_MS, REPLY_POLL_MS, REPLY_WAIT_MS } from "../../lib/client/gate/gate-session";
import { createIdleNudger, IDLE_NUDGE_MS } from "../../lib/client/tutor/idle-nudge";
import { createConversationBridge } from "../../lib/client/voice/bridge";
import { coachKey, createCoachTurnVoice, type SpeakableCoachTurn } from "../../lib/client/tutor/speech";
import { coachActivity, conversationLines } from "../../lib/client/tutor/view";
import { jsonResponse, scriptedFetch, tick } from "./fake-fetch";
import { manualClock, question } from "./interview-support";

const NONCE = "nonce_0123456789abcdefghij";
const CONTROL = `⟦ctl:${NONCE}⟧`;

const coachTurn = (id: string, over: Partial<Question> = {}): Question =>
  question(id, { kind: "coach_turn", ephemeral: true, value: 90, reason: "coach reply", text: "Look at who owns the company first.", ...over });

function tutorGate() {
  const time = manualClock();
  const queue: Question[] = [];
  const net = scriptedFetch((url, body) => {
    if (url.endsWith("/questions")) return jsonResponse({ queue, contextVersion: 4, asked: [], offRecord: false });
    if (url.endsWith("/gate/authorize")) {
      const { questionId } = body as { questionId: string };
      queue.splice(queue.findIndex((q) => q.id === questionId), 1);
      return jsonResponse({
        authorization: { sessionId: "s-1", questionId, nonce: NONCE, expiresAt: 1_800_000_000_000, contextVersion: 4 },
        controlMessage: CONTROL,
        text: "Look at who owns the company first.",
      });
    }
    return jsonResponse({ error: "not_found" }, 404);
  });
  const sent: string[] = [];
  const gate = createGateSession({
    sessionId: "s-1",
    mode: "tutor",
    fetch: net.fetch,
    clock: time.clock,
    sendControlMessage: (text) => sent.push(text),
    holdAgent: () => {},
    onAsked: () => {},
  });
  const authorizeCalls = () => net.requests.filter((r) => r.url.endsWith("/gate/authorize"));
  const queueCalls = () => net.requests.filter((r) => r.url.endsWith("/questions"));
  /** Advances in 50 ms steps, letting responses settle; `each` runs before every step (e.g. the screen moving). */
  const run = async (ms: number, each?: () => void) => {
    for (let elapsed = 0; elapsed < ms; elapsed += 50) {
      each?.();
      time.advance(Math.min(50, ms - elapsed));
      await tick();
    }
  };
  return { time, gate, queue, sent, authorizeCalls, queueCalls, run };
}

describe("tutor gate: the coach's turns", () => {
  it("speaks a reply promptly once the trainee stops, while the screen keeps moving and they type", async () => {
    const { gate, queue, sent, authorizeCalls, queueCalls, run } = tutorGate();
    await tick();
    gate.setVoiceLive(true);
    const busy = () => {
      gate.screenMotion();
      gate.typing();
    };
    // The trainee talks for 2 s; a nudge already queued must wait for them.
    gate.vad(0.9);
    queue.push(coachTurn("nudge-1", { reason: "coach idle" }));
    await run(2000, busy);
    expect(authorizeCalls()).toHaveLength(0);
    gate.vad(0.05);
    await run(300, busy);
    gate.transcript(true); // the provider's final transcript: the bridge posts the utterance now
    // The nudge goes once the trainee has paused for coachSilenceMs (0.7 s), screen and keyboard notwithstanding.
    await run(650, busy);
    expect(authorizeCalls()).toHaveLength(0);
    await run(100, busy);
    expect(authorizeCalls().map((r) => (r.body as { questionId: string }).questionId)).toEqual(["nudge-1"]);
    expect(sent).toEqual([CONTROL]);
    // The coach speaks it and stops; the trainee answers.
    gate.agentSpeaking(true);
    await run(2000, busy);
    gate.agentSpeaking(false);
    gate.vad(0.9);
    await run(1500, busy);
    gate.vad(0.05);
    const pollsBefore = queueCalls().length;
    gate.transcript(true);
    expect(gate.snapshot().awaitingReply).toBe(true);
    // The server's grounded reply is queued 1.2 s after the transcript: read within a poll of REPLY_POLL_MS.
    await run(1200, busy);
    expect(queueCalls().length - pollsBefore).toBeGreaterThanOrEqual(Math.floor(1200 / REPLY_POLL_MS));
    queue.push(coachTurn("reply-1"));
    await run(REPLY_POLL_MS + 50, busy);
    expect(authorizeCalls().map((r) => (r.body as { questionId: string }).questionId)).toEqual(["nudge-1", "reply-1"]);
    expect(sent).toEqual([CONTROL, CONTROL]);
    expect(gate.snapshot().awaitingReply).toBe(false);
  });

  it("is not counted against the live budget: many coach turns in a row are all spoken", async () => {
    const { gate, queue, authorizeCalls, run } = tutorGate();
    await tick();
    gate.setVoiceLive(true);
    for (let i = 0; i < 7; i += 1) {
      queue.push(coachTurn(`c${i}`));
      gate.expectReply();
      await run(500);
      gate.agentSpeaking(true);
      await run(1000);
      gate.agentSpeaking(false);
      await run(2500);
    }
    expect(authorizeCalls()).toHaveLength(7);
  });

  it("reads the queue every REPLY_POLL_MS only while a reply is due, then returns to the normal pace", async () => {
    const { gate, queueCalls, run } = tutorGate();
    await tick();
    gate.setVoiceLive(true);
    gate.expectReply();
    await run(REPLY_WAIT_MS);
    const fast = queueCalls().length;
    expect(fast).toBeGreaterThanOrEqual(REPLY_WAIT_MS / REPLY_POLL_MS - 2);
    expect(gate.snapshot().awaitingReply).toBe(false);
    await run(5000);
    expect(queueCalls().length - fast).toBeLessThanOrEqual(5000 / QUEUE_POLL_MS + 1);
  });
});

describe("barge-in: the trainee talks over the coach", () => {
  it("the cut-off coach turn is recorded as spoken, the trainee's words are posted at once, and the gate is free for the next reply", async () => {
    const { time, gate, queue, sent, authorizeCalls, run } = tutorGate();
    const net = scriptedFetch(() => jsonResponse({ utteranceId: "u-1" }));
    // Not an inline literal: the upstream bridge also takes `setTimer` (agent-initialisation fallback).
    const options = {
      sessionId: "s-1",
      fetch: net.fetch,
      now: time.now,
      gate,
      privacy: () => ({ offRecord: false, epoch: 1 }),
      vadThreshold: 0.4,
      onOffRecordPhrase: () => {},
      setTimer: time.clock.setTimer,
    };
    const bridge = createConversationBridge(options);
    await tick();
    bridge.connected("conv-1");
    gate.setVoiceLive(true); // the agent has initialised the conversation (upstream: `bridge.initialised()`)
    queue.push(coachTurn("c-1"));
    gate.expectReply();
    await run(300);
    expect(authorizeCalls()).toHaveLength(1);
    bridge.asked("c-1");
    bridge.mode("speaking");
    await run(1000);
    // The trainee starts talking; ElevenLabs cuts the agent off.
    bridge.vad(0.9);
    await run(100);
    bridge.mode("listening");
    bridge.message({ role: "agent", message: "Look at who owns" });
    await run(1500);
    bridge.vad(0.05);
    await run(200);
    bridge.message({ role: "user", message: "Wait, does the owner matter if they hold less than a quarter?" });
    await tick();
    const posted = net.requests.map((r) => [r.url.replace(/^.*\/sessions\/s-1/, ""), (r.body as { questionId?: string }).questionId]);
    expect(posted).toEqual([
      ["/agent-utterances", "c-1"],
      ["/utterances", "c-1"],
    ]);
    // The server's reply to the interruption is queued ~1 s later and spoken once the trainee has paused.
    await run(1000);
    queue.push(coachTurn("c-2", { text: "Under a quarter, the expert's rule does not apply." }));
    await run(REPLY_POLL_MS + 50);
    expect(authorizeCalls().map((r) => (r.body as { questionId: string }).questionId)).toEqual(["c-1", "c-2"]);
    expect(sent).toHaveLength(2);
  });
});

describe("browser voice for coach turns (no agent connected)", () => {
  const turn = (id: string, over: Partial<SpeakableCoachTurn> = {}): SpeakableCoachTurn => ({
    id,
    role: "coach",
    text: `Coach line ${id}.`,
    trigger: "reply",
    spoken: false,
    ...over,
  });
  const speaker = () => {
    const said: string[] = [];
    const spoken = new Set<string>();
    return {
      said,
      speakOnce: (key: string, text: string) => {
        if (spoken.has(key)) return false;
        spoken.add(key);
        said.push(`${key} ${text}`);
        return true;
      },
    };
  };

  it("never reads the history, then reads each new coach turn once", () => {
    const s = speaker();
    const voice = createCoachTurnVoice(s);
    const history = [turn("old-1"), turn("t-1", { role: "trainee", trigger: null })];
    expect(voice.observe(history, false)).toBeNull();
    const next = [...history, turn("t-2", { role: "trainee", trigger: null, text: "Why not approve?" }), turn("c-2")];
    expect(voice.observe(next, false)).toBe("c-2");
    expect(voice.observe(next, false)).toBeNull();
    expect(voice.observe([...next], false)).toBeNull();
    expect(s.said).toEqual([`${coachKey("c-2")} Coach line c-2.`]);
  });

  it("leaves turns to the connected agent, to the reveal and warning cards, and skips what the agent already spoke", () => {
    const s = speaker();
    const voice = createCoachTurnVoice(s);
    voice.observe([], false);
    expect(voice.observe([turn("a")], true)).toBeNull(); // the agent is connected: it speaks
    expect(voice.observe([turn("a")], false)).toBeNull(); // seen while connected: not read later
    expect(voice.observe([turn("a"), turn("p", { trigger: "prediction" })], false)).toBeNull();
    expect(voice.observe([turn("a"), turn("p", { trigger: "prediction" }), turn("w", { trigger: "intervention" })], false)).toBeNull();
    expect(voice.observe([turn("v", { spoken: true })], false)).toBeNull();
    expect(voice.observe([turn("v", { spoken: true }), turn("x"), turn("y")], false)).toBe("y"); // only the newest
    expect(s.said).toEqual([`${coachKey("y")} Coach line y.`]);
  });
});

describe("idle nudge", () => {
  it("nudges once per case after IDLE_NUDGE_MS without activity, only while eligible", () => {
    const time = manualClock();
    const nudged: string[] = [];
    const nudger = createIdleNudger({ setTimer: time.clock.setTimer, nudge: (caseId) => nudged.push(caseId) });
    nudger.update("case-1", false); // coach not connected
    time.advance(IDLE_NUDGE_MS * 2);
    expect(nudged).toEqual([]);
    nudger.update("case-1", true);
    time.advance(IDLE_NUDGE_MS - 1000);
    nudger.activity(); // the trainee clicked: the clock restarts
    time.advance(IDLE_NUDGE_MS - 1);
    expect(nudged).toEqual([]);
    nudger.update("case-1", true); // a re-render with the same values changes nothing
    time.advance(1);
    expect(nudged).toEqual(["case-1"]);
    time.advance(IDLE_NUDGE_MS * 3);
    nudger.activity();
    time.advance(IDLE_NUDGE_MS * 3);
    expect(nudged).toEqual(["case-1"]); // at most once per case
    nudger.update("case-2", true);
    time.advance(IDLE_NUDGE_MS / 2);
    nudger.update("case-2", false); // decided (or the coach disconnected)
    time.advance(IDLE_NUDGE_MS);
    expect(nudged).toEqual(["case-1"]);
    nudger.update("case-3", true);
    nudger.dispose();
    time.advance(IDLE_NUDGE_MS);
    expect(nudged).toEqual(["case-1"]);
  });
});

describe("coach conversation display", () => {
  it("shows the last few lines, local words until the server has them", () => {
    const server = [
      { id: "1", role: "coach" as const, text: "Welcome." },
      { id: "2", role: "trainee" as const, text: "Why enhanced review?" },
    ];
    expect(conversationLines({ server, spoken: [{ id: 9, text: "why enhanced review?" }], asked: { text: "And the PEP?" }, reply: null })).toEqual([
      { key: "1", role: "coach", text: "Welcome." },
      { key: "2", role: "trainee", text: "Why enhanced review?" },
      { key: "asked", role: "trainee", text: "And the PEP?" },
    ]);
    const lines = conversationLines({
      server: [...server, { id: "3", role: "trainee", text: "And the PEP?" }, { id: "4", role: "coach", text: "A PEP always needs review." }],
      asked: { text: "And the PEP?" },
      reply: { text: "A PEP always needs review." },
    });
    expect(lines.map((l) => l.key)).toEqual(["1", "2", "3", "4"]);
    expect(conversationLines({ server: [...server, ...server.map((t) => ({ ...t, id: `${t.id}b` }))], max: 3 })).toHaveLength(3);
  });

  it("says what the coach is doing in one word", () => {
    const base = { voiceLive: true, agentSpeaking: false, browserSpeaking: false, awaitingReply: false };
    expect(coachActivity(base)).toBe("listening");
    expect(coachActivity({ ...base, awaitingReply: true })).toBe("thinking");
    expect(coachActivity({ ...base, awaitingReply: true, agentSpeaking: true })).toBe("speaking");
    expect(coachActivity({ ...base, voiceLive: false })).toBeNull();
    expect(coachActivity({ ...base, voiceLive: false, browserSpeaking: true })).toBe("speaking");
  });
});
