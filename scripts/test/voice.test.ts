import { describe, expect, it } from "vitest";
import { checkVoiceOffRecord, checkVoiceSkipTurn, OFF_RECORD_PROBE_TEXT, PHASE_A_TEXT } from "../preflight/checks/voice";
import {
  fakeAgentSockets,
  fakeElevenLabs,
  fakeServer,
  makeContext,
  SECRET,
  type FakeServerBehaviour,
  type SocketScript,
} from "./support/fakes";

function setup(script: SocketScript = {}, overrides: Parameters<typeof makeContext>[0] = {}, behaviour: FakeServerBehaviour = {}) {
  const server = fakeServer(behaviour);
  const sockets = fakeAgentSockets(server, script);
  const eleven = fakeElevenLabs();
  const ctx = makeContext({ fetch: server.fetch, WebSocket: sockets.factory, createElevenLabs: () => eleven, ...overrides });
  return { ctx, server, sockets, eleven };
}

describe("voice-skip-turn", () => {
  it("passes: silent on the unauthorised turn, exact text plus audio on the authorised one", async () => {
    const { ctx, sockets, server, eleven } = setup({ echoTranscript: true });
    const r = await checkVoiceSkipTurn(ctx);
    expect(r.detail).toMatch(/^conversation conv_1: silent for 40 ms on an unauthorised turn; authorised text after \d+ ms, first audio after \d+ ms$/);
    expect(r.status).toBe("pass");

    const [socket] = sockets.sockets;
    expect(sockets.sockets).toHaveLength(1);
    expect(socket?.url).toBe(eleven.signedUrls[0]);
    const sent = socket?.sent ?? [];
    // Initiation carries the ledger session; pings are answered; phase A then phase B.
    expect(sent[0]).toEqual({ type: "conversation_initiation_client_data", custom_llm_extra_body: { sessionId: "preflight-1" } });
    expect(sent.filter((m) => m.type === "pong")).toEqual([{ type: "pong", event_id: expect.any(Number) }]);
    const userMessages = sent.filter((m) => m.type === "user_message").map((m) => m.text);
    expect(userMessages[0]).toBe(PHASE_A_TEXT);
    expect(userMessages[1]).toMatch(/^⟦ctl:[A-Za-z0-9_-]+⟧$/);
    expect(server.authorizeCount).toBe(1);
    // Closed cleanly by the client.
    expect(socket?.closedByClient).toEqual({ code: 1000, reason: "preflight done" });

    expect(r.facts).toMatchObject({
      phaseA: { events: { agent_tool_response: 1, user_transcript: 1 }, toolResponses: [{ toolName: "skip_turn", status: "success" }], userTranscriptEchoed: true },
      phaseB: { reconnected: false, audioEvents: 2, firstAudioMs: expect.any(Number), agentResponseMs: expect.any(Number) },
      pings: 1,
      pongs: 1,
      unexpectedEventTypes: [],
      conversationIds: ["conv_1"],
      observed: { bearerAuth: expect.stringMatching(/^verified/), streamedSkipTurn: expect.stringMatching(/^accepted.*skip_turn observed/), preToolSpeech: expect.stringMatching(/^none/) },
    });
  });

  it("fails if any agent speech or audio arrives in the quiet window", async () => {
    const { ctx } = setup({ speakOnAnyMessage: true });
    const r = await checkVoiceSkipTurn(ctx);
    expect(r.status).toBe("fail");
    expect(r.detail).toMatch(/phase A: agent spoke without authorization \(2 audio, 1 agent_response\)/);
    expect(r.facts?.observed).toMatchObject({ preToolSpeech: "speech observed in phase A" });
  });

  it("fails when the authorised turn produces no speech, after the timeout, and still closes the socket", async () => {
    const { ctx, sockets } = setup({ silent: true });
    const started = performance.now();
    const r = await checkVoiceSkipTurn(ctx);
    expect(performance.now() - started).toBeGreaterThanOrEqual(200);
    expect(r.status).toBe("fail");
    expect(r.detail).toContain("phase B: no agent_response equal to the authorised text within 200 ms");
    expect(r.detail).toContain("phase B: no audio within 200 ms");
    expect(sockets.sockets[0]?.closedByClient).toEqual({ code: 1000, reason: "preflight done" });
  });

  it("re-authorises on a fresh conversation when the authorization would expire before phase B", async () => {
    const { ctx, sockets, server } = setup({}, {});
    ctx.options.minAuthorizationRemainingMs = 120_000;
    const r = await checkVoiceSkipTurn(ctx);
    expect(r.status).toBe("pass");
    expect(server.authorizeCount).toBe(2);
    expect(sockets.sockets).toHaveLength(2);
    expect(sockets.sockets[1]?.sent[0]).toEqual({ type: "conversation_initiation_client_data", custom_llm_extra_body: { sessionId: "preflight-2" } });
    expect(sockets.sockets.map((s) => s.closedByClient?.code)).toEqual([1000, 1000]);
    expect(r.facts).toMatchObject({ phaseB: { reconnected: true }, conversationIds: ["conv_1", "conv_2"] });
  });

  it("reports unexpected event types", async () => {
    const { ctx } = setup({ extraEvent: "mcp_connection_status" });
    const r = await checkVoiceSkipTurn(ctx);
    expect(r.status).toBe("pass");
    expect(r.detail).toContain("unexpected events: mcp_connection_status");
  });

  it("fails cleanly when the conversation never starts", async () => {
    const { ctx, sockets } = setup({ noMetadata: true });
    await expect(checkVoiceSkipTurn(ctx)).rejects.toThrow(/no conversation_initiation_metadata within 200 ms/);
    expect(sockets.sockets[0]?.closedByClient?.code).toBe(1000);
  });

  it("fails when the server ends the conversation", async () => {
    const { ctx } = setup({ closeAfterMetadata: true });
    const r = await checkVoiceSkipTurn(ctx);
    expect(r.status).toBe("fail");
    expect(r.detail).toMatch(/phase A: conversation ended during the quiet window \(closed 1011 internal error\)/);
  });

  it("refuses a localhost or http target without opening a conversation", async () => {
    const { ctx, sockets, server } = setup({}, { cliTarget: "http://127.0.0.1:3000" });
    const r = await checkVoiceSkipTurn(ctx);
    expect(r).toMatchObject({ status: "fail", detail: expect.stringMatching(/ElevenLabs calls the custom LLM from its own servers/) });
    expect(sockets.sockets).toHaveLength(0);
    expect(server.requests).toHaveLength(0);
  });

  it("never exposes the signed URL, nonce or control message", async () => {
    const { ctx, server, eleven } = setup({ echoTranscript: true });
    const r = await checkVoiceSkipTurn(ctx);
    const out = ctx.secrets.text(JSON.stringify(ctx.secrets.value(r)));
    for (const nonce of server.authorizations.keys()) expect(out).not.toContain(nonce);
    for (const url of eleven.signedUrls) expect(out).not.toContain(url.split("conversation_signature=")[1]);
    expect(out).not.toContain(SECRET);
    expect(out).toContain("conv_1");
  });
});

describe("voice-off-record", () => {
  it("passes: exactly one set_off_record client tool call and no speech", async () => {
    const { ctx, sockets, server } = setup();
    const r = await checkVoiceOffRecord(ctx);
    expect(r.detail).toMatch(/^conversation conv_1: set_off_record client tool call after \d+ ms, no speech for 40 ms$/);
    expect(r.status).toBe("pass");
    const sent = sockets.sockets[0]?.sent ?? [];
    expect(sent[0]).toEqual({ type: "conversation_initiation_client_data", custom_llm_extra_body: { sessionId: "preflight-1" } });
    expect(sent.filter((m) => m.type === "user_message").map((m) => m.text)).toEqual([OFF_RECORD_PROBE_TEXT]);
    expect(server.authorizeCount).toBe(1);
    expect(sockets.sockets[0]?.closedByClient).toEqual({ code: 1000, reason: "preflight done" });
    expect(r.facts).toMatchObject({
      clientToolCalls: [{ toolName: "set_off_record", offRecord: true }],
      toolCallMs: expect.any(Number),
      unexpectedEventTypes: [],
    });
  });

  it("fails against a server without the off-record branch (skip_turn only)", async () => {
    const { ctx } = setup({}, {}, { ignoreOffRecordPhrase: true });
    const r = await checkVoiceOffRecord(ctx);
    expect(r.status).toBe("fail");
    expect(r.detail).toBe("expected exactly one client_tool_call, got 0");
  });

  it("fails when the agent speaks", async () => {
    const { ctx } = setup({ speakOnAnyMessage: true });
    const r = await checkVoiceOffRecord(ctx);
    expect(r.status).toBe("fail");
    expect(r.detail).toMatch(/agent spoke on the off-record phrase \(2 audio, 1 agent_response\)/);
  });

  it("fails when the tool call repeats (the LLM was re-invoked with the same turn)", async () => {
    const { ctx } = setup({ repeatClientToolCall: true });
    const r = await checkVoiceOffRecord(ctx);
    expect(r.status).toBe("fail");
    expect(r.detail).toBe("expected exactly one client_tool_call, got 2 (set_off_record, set_off_record)");
  });

  it("refuses a localhost target without opening a conversation", async () => {
    const { ctx, sockets } = setup({}, { cliTarget: "http://127.0.0.1:3000" });
    const r = await checkVoiceOffRecord(ctx);
    expect(r.status).toBe("fail");
    expect(sockets.sockets).toEqual([]);
  });
});
