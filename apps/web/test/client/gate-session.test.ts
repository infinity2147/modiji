import { describe, expect, it } from "vitest";
import { CONDITION_KEYS, type Question } from "@vashistha/core";
import { createGateSession, QUEUE_POLL_MS } from "../../lib/client/gate/gate-session";
import { jsonResponse, scriptedFetch, tick } from "./fake-fetch";
import { manualClock, question } from "./interview-support";

const NONCE = "nonce_0123456789abcdefghij";
const CONTROL = `⟦ctl:${NONCE}⟧`;

type Authorize = (body: { questionId: string }) => Response;

const granted: Authorize = (body) =>
  jsonResponse({
    authorization: { sessionId: "s-1", questionId: body.questionId, nonce: NONCE, expiresAt: 1_800_000_000_000, contextVersion: 7 },
    controlMessage: CONTROL,
    text: "Was it the ownership share or the jurisdiction?",
  });

function setup(opts: { queue?: Question[]; authorize?: Authorize } = {}) {
  const time = manualClock();
  const queue = opts.queue ?? [question("q-1")];
  const net = scriptedFetch((url, body) => {
    if (url.endsWith("/questions")) return jsonResponse({ queue, contextVersion: 7, asked: [], offRecord: false });
    if (url.endsWith("/gate/authorize")) return (opts.authorize ?? granted)(body as { questionId: string });
    return jsonResponse({ error: "not_found" }, 404);
  });
  const sent: string[] = [];
  const asked: string[] = [];
  const gate = createGateSession({
    sessionId: "s-1",
    mode: "interviewer",
    fetch: net.fetch,
    clock: time.clock,
    sendControlMessage: (text) => sent.push(text),
    holdAgent: () => {},
    onAsked: (a) => asked.push(a.questionId),
  });
  const authorizeCalls = () => net.requests.filter((r) => r.url.endsWith("/gate/authorize"));
  const queueCalls = () => net.requests.filter((r) => r.url.endsWith("/questions"));
  /** Advances the clock in poll-sized steps, letting each poll's response settle. */
  const run = async (ms: number) => {
    for (let elapsed = 0; elapsed < ms; elapsed += QUEUE_POLL_MS) {
      time.advance(Math.min(QUEUE_POLL_MS, ms - elapsed));
      await tick();
    }
  };
  return { time, net, gate, sent, asked, authorizeCalls, queueCalls, run };
}

describe("browser gate session", () => {
  it("authorizes the queued question at a quiet breakpoint and sends the control message exactly once", async () => {
    const { gate, sent, asked, authorizeCalls, run, time } = setup();
    await tick();
    gate.setVoiceLive(true);
    gate.committed();
    await tick();

    expect(authorizeCalls()).toHaveLength(1);
    expect(authorizeCalls()[0]?.body).toEqual({
      questionId: "q-1",
      contextVersion: 7,
      becameValidAt: time.now(),
      decidedAt: time.now(),
      conditions: Object.fromEntries(CONDITION_KEYS.map((k) => [k, true])),
    });
    expect(sent).toEqual([CONTROL]);
    expect(asked).toEqual(["q-1"]);
    expect(gate.snapshot().latency).toHaveLength(1);

    // The question stays queued on the server for a while: it is never asked twice.
    await run(30_000);
    expect(authorizeCalls()).toHaveLength(1);
    expect(sent).toEqual([CONTROL]);
  });

  it("waits while the user types, then authorizes once typing has been idle for 1.5 s", async () => {
    const { gate, sent, authorizeCalls, time } = setup();
    await tick();
    gate.setVoiceLive(true);
    gate.typing();
    gate.committed();
    const typing = gate.snapshot().hud.judge.find((r) => r.key === "typingIdle");
    expect(typing).toMatchObject({ ok: false, text: "wait 1.5 s" });
    expect(gate.snapshot().hud.status).toBe("WAITING");
    time.advance(1499);
    await tick();
    expect(authorizeCalls()).toHaveLength(0);
    time.advance(1);
    await tick();
    expect(authorizeCalls()).toHaveLength(1);
    expect(sent).toEqual([CONTROL]);
  });

  it("records a refusal, sends nothing and re-reads the queue", async () => {
    const { gate, sent, authorizeCalls, queueCalls, time } = setup({
      authorize: () => jsonResponse({ error: "context_changed", detail: "the case changed" }, 409),
    });
    await tick();
    gate.setVoiceLive(true);
    const pollsBefore = queueCalls().length;
    gate.committed();
    await tick();

    expect(authorizeCalls()).toHaveLength(1);
    expect(sent).toEqual([]);
    expect(gate.snapshot().refusals).toEqual([
      expect.objectContaining({ questionId: "q-1", code: "context_changed" }),
    ]);
    // The refusal schedules an immediate re-read (a zero-delay timer), well before the next 1 s poll.
    time.advance(0);
    await tick();
    expect(queueCalls().length).toBe(pollsBefore + 1);
  });

  it("never calls authorize while off the record", async () => {
    const { gate, sent, authorizeCalls, run } = setup();
    await tick();
    gate.setOffRecord(true);
    gate.setVoiceLive(true);
    gate.committed();
    await run(20_000);
    expect(authorizeCalls()).toHaveLength(0);
    expect(sent).toEqual([]);
    expect(gate.snapshot().hud.reason).toBe("off the record: the agent stays silent");

    // Back on the record, the queued question can be asked again.
    gate.setOffRecord(false);
    await run(QUEUE_POLL_MS);
    expect(authorizeCalls()).toHaveLength(1);
  });

  it("offers no question to the gate while no voice conversation is live", async () => {
    const { gate, authorizeCalls, run } = setup();
    await tick();
    gate.committed();
    await run(10_000);
    expect(authorizeCalls()).toHaveLength(0);
    expect(gate.snapshot().hud.status).toBe("LISTENING");
    expect(gate.snapshot().queue).toHaveLength(1);
  });

  it("does not speak an authorization that arrives after going off the record", async () => {
    let release: () => void = () => {};
    const time = manualClock();
    const sent: string[] = [];
    const gate = createGateSession({
      sessionId: "s-1",
      mode: "interviewer",
      clock: time.clock,
      fetch: async (url, init) => {
        if (url.endsWith("/questions")) return jsonResponse({ queue: [question("q-1")], contextVersion: 7, asked: [], offRecord: false });
        await new Promise<void>((resolve) => (release = resolve));
        return granted(JSON.parse(String(init?.body)) as { questionId: string });
      },
      sendControlMessage: (text) => sent.push(text),
      holdAgent: () => {},
      onAsked: () => {},
    });
    await tick();
    gate.setVoiceLive(true);
    gate.committed();
    await tick();
    gate.setOffRecord(true);
    release();
    await tick();
    expect(sent).toEqual([]);
    expect(gate.snapshot().refusals[0]?.code).toBe("off_record");
    gate.dispose();
  });
});
