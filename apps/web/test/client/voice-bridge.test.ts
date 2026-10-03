import { describe, expect, it } from "vitest";
import { formatControlMessage } from "@vashistha/core";
import { createConversationBridge, isControlText } from "../../lib/client/voice/bridge";
import type { PrivacyBase } from "../../lib/client/voice/privacy";
import { controlledFetch, jsonResponse, scriptedFetch, tick } from "./fake-fetch";

const CONTROL = formatControlMessage("nonce_0123456789abcdefghij");

function setup(fetchFn = scriptedFetch(() => jsonResponse({ utteranceId: "u-1" })).fetch) {
  let now = 1_700_000_000_000;
  const privacy: PrivacyBase = { offRecord: false, epoch: 2 };
  const gateCalls: string[] = [];
  const offRecordPhrases: number[] = [];
  const bridge = createConversationBridge({
    sessionId: "s-1",
    fetch: fetchFn,
    now: () => now,
    gate: {
      vad: (score) => gateCalls.push(`vad:${score}`),
      agentSpeaking: (speaking) => gateCalls.push(`agent:${speaking}`),
      setVoiceLive: (live) => gateCalls.push(`live:${live}`),
    },
    privacy: () => privacy,
    vadThreshold: 0.4,
    onOffRecordPhrase: () => offRecordPhrases.push(now),
  });
  return { bridge, privacy, gateCalls, offRecordPhrases, advance: (ms: number) => (now += ms) };
}

describe("control-message filtering", () => {
  it("recognises exact control messages and any text carrying one", () => {
    expect(isControlText(CONTROL)).toBe(true);
    expect(isControlText(`  ${CONTROL}\n`)).toBe(true);
    expect(isControlText(`ok ${CONTROL}`)).toBe(true);
    expect(isControlText("⟦ctl:short⟧")).toBe(true);
    expect(isControlText("It was the ownership share.")).toBe(false);
  });

  it("never shows or posts a control message echoed back as a user transcript", async () => {
    const net = scriptedFetch(() => jsonResponse({ utteranceId: "u-1" }));
    const { bridge } = setup(net.fetch);
    bridge.connected("conv-1");
    bridge.message({ role: "user", message: CONTROL });
    bridge.message({ role: "agent", message: CONTROL });
    await tick();
    expect(bridge.transcript()).toEqual([]);
    expect(net.requests).toEqual([]);
  });
});

describe("conversation bridge", () => {
  it("feeds VAD and agent mode to the gate and marks voice live/not live", () => {
    const { bridge, gateCalls } = setup();
    bridge.connected("conv-1");
    bridge.vad(0.8);
    bridge.mode("speaking");
    bridge.mode("listening");
    bridge.disconnected();
    expect(gateCalls).toEqual(["live:true", "vad:0.8", "agent:true", "agent:false", "live:false"]);
  });

  it("tags the agent's question and the expert's answer with the asked question id and the privacy epoch", async () => {
    const net = scriptedFetch((url) => (url.endsWith("/utterances") ? jsonResponse({ utteranceId: "u-1" }) : jsonResponse({}, 201)));
    const { bridge, advance } = setup(net.fetch);
    bridge.connected("conv-1");
    bridge.asked("q-1");
    advance(1000);
    bridge.message({ role: "agent", message: "Was it the ownership share or the jurisdiction?" });
    advance(2000);
    bridge.vad(0.9);
    advance(1500);
    bridge.vad(0.1);
    bridge.message({ role: "user", message: "The ownership share — anything over 25 percent." });
    bridge.message({ role: "user", message: "And it's a new customer." });
    await tick();

    expect(net.requests.map((r) => [r.url, r.body])).toEqual([
      [
        "/api/sessions/s-1/agent-utterances",
        { conversationId: "conv-1", text: "Was it the ownership share or the jurisdiction?", questionId: "q-1" },
      ],
      [
        "/api/sessions/s-1/utterances",
        {
          conversationId: "conv-1",
          text: "The ownership share — anything over 25 percent.",
          t0Ms: 3000,
          t1Ms: 4500,
          questionId: "q-1",
          privacyEpoch: 2,
        },
      ],
      ["/api/sessions/s-1/utterances", { conversationId: "conv-1", text: "And it's a new customer.", t0Ms: 4500, t1Ms: 4500, privacyEpoch: 2 }],
    ]);
    expect(bridge.transcript().map((t) => [t.role, t.questionId])).toEqual([
      ["agent", "q-1"],
      ["user", "q-1"],
      ["user", undefined],
    ]);
  });

  it("captures nothing while off the record and drops queued uploads when going off", async () => {
    const net = controlledFetch();
    const { bridge, privacy } = setup(net.fetch);
    bridge.connected("conv-1");
    bridge.message({ role: "user", message: "first" });
    bridge.message({ role: "user", message: "second (queued)" });
    expect(net.requests).toHaveLength(1);
    expect(bridge.uploads().pending).toBe(2);

    privacy.offRecord = true;
    bridge.cancelQueued();
    bridge.message({ role: "user", message: "off record: should never leave the browser" });
    net.next().resolve(jsonResponse({ utteranceId: "u-1" }));
    await tick();

    expect(net.requests.map((r) => (r.body as { text: string }).text)).toEqual(["first"]);
    expect(bridge.transcript().map((t) => t.text)).toEqual(["first", "second (queued)"]);
    expect(bridge.uploads()).toEqual({ pending: 0, failed: 0, lastError: undefined });
  });

  it("drops an utterance captured in an earlier privacy epoch", async () => {
    const net = controlledFetch();
    const { bridge, privacy } = setup(net.fetch);
    bridge.connected("conv-1");
    bridge.message({ role: "user", message: "in flight" });
    bridge.message({ role: "user", message: "captured in epoch 2" });
    privacy.epoch = 4;
    net.next().resolve(jsonResponse({ utteranceId: "u-1" }));
    await tick();
    expect(net.requests).toHaveLength(1);
  });

  it("reports an upload that the server refused", async () => {
    const net = scriptedFetch(() => jsonResponse({ error: "stale_epoch" }, 409));
    const { bridge } = setup(net.fetch);
    bridge.connected("conv-1");
    bridge.message({ role: "user", message: "hello" });
    await tick();
    expect(bridge.uploads()).toMatchObject({ pending: 0, failed: 1 });
    expect(bridge.uploads().lastError).toContain("stale_epoch");
  });
});

describe("off-record phrase", () => {
  it("never shows or posts the expert's off-record phrase, and goes off the record at once", async () => {
    const net = scriptedFetch(() => jsonResponse({ utteranceId: "u-1" }));
    const { bridge, offRecordPhrases } = setup(net.fetch);
    bridge.connected("conv-1");
    bridge.message({ role: "user", message: "Okay, let's go off the record for a moment." });
    bridge.message({ role: "user", message: "रिकॉर्डिंग बंद करो।" });
    await tick();
    expect(offRecordPhrases).toHaveLength(2);
    expect(bridge.transcript()).toEqual([]);
    expect(net.requests).toEqual([]);
  });

  it("records ordinary answers, and agent turns even if they mention the phrase", async () => {
    const net = scriptedFetch(() => jsonResponse({ utteranceId: "u-1" }));
    const { bridge, offRecordPhrases } = setup(net.fetch);
    bridge.connected("conv-1");
    bridge.message({ role: "agent", message: "Off the record?" });
    bridge.message({ role: "user", message: "The record shows the owner is verified." });
    await tick();
    expect(offRecordPhrases).toEqual([]);
    expect(bridge.transcript().map((t) => t.role)).toEqual(["agent", "user"]);
  });
});
