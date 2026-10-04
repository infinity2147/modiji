import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createOffRecordPhraseMatcher, formatControlMessage } from "@vashistha/core";
import type { Ledger } from "@vashistha/core/server";
import { nonceDigest } from "../../lib/server/authorizations";
import { handleChatCompletion } from "../../lib/server/custom-llm";
import { PREFLIGHT_QUESTION, PREFLIGHT_QUESTION_ID, issuePreflightAuthorization } from "../../lib/server/preflight";
import { SECRET, T0, chatBody, chatRequest, createHarness, readTurn, type Harness } from "../support/llm-harness";

const QUESTION = "Why did you escalate this case instead of approving it outright?";
const EXTRA_CANARY = "extra-body-canary-7f3a";

let h: Harness;
beforeEach(() => {
  h = createHarness();
  h.ledger.createSession({ id: "s1" });
});
afterEach(() => h.opened.close());

function issue(over: { sessionId?: string; agent?: "interviewer" | "tutor"; ttlMs?: number; text?: string } = {}) {
  const sessionId = over.sessionId ?? "s1";
  return h.authorizations.issue({
    sessionId,
    agent: over.agent ?? "interviewer",
    questionId: "q-escalate",
    text: over.text ?? QUESTION,
    contextVersion: h.authorizations.getContextVersion(sessionId),
    ttlMs: over.ttlMs ?? 4_000,
  });
}

function controlTurn(nonce: string, opts: { model?: string; sessionId?: string | null } = {}) {
  const sessionId = opts.sessionId === undefined ? "s1" : opts.sessionId;
  return chatBody({
    ...(opts.model ? { model: opts.model } : {}),
    messages: [
      { role: "assistant", content: "Earlier question?" },
      { role: "user", content: "Earlier expert answer." },
      { role: "user", content: formatControlMessage(nonce) },
    ],
    ...(sessionId === null ? {} : { extraBody: { sessionId, canary: EXTRA_CANARY } }),
  });
}

describe("authentication", () => {
  it.each([
    ["no header", {}, "absent"],
    ["wrong secret", { authorization: `Bearer ${"x".repeat(40)}` }, "bearer"],
    ["basic scheme", { authorization: `Basic ${Buffer.from(`u:${SECRET}`).toString("base64")}` }, "basic"],
    ["secret without a scheme", { authorization: SECRET }, "other"],
    ["secret in another header", { "xi-api-key": SECRET }, "absent"],
  ])("401 for %s, logging the scheme name but never a value", async (_name, headers, scheme) => {
    const response = await h.call(controlTurn(issue().nonce), headers);
    expect(response.status).toBe(401);
    expect(response.headers.get("www-authenticate")).toMatch(/^Bearer/);
    expect(await response.json()).toEqual({ error: "unauthorized" });
    expect(h.logs).toHaveLength(1);
    expect(h.logs[0]).toContain(`scheme=${scheme}`);
    expect(h.logs.join("\n")).not.toContain(SECRET);
    expect(h.logs.join("\n")).not.toContain("x".repeat(40));
    expect(h.ledger.list("s1")).toEqual([]);
  });

  it("names auth-like headers (not values) in the 401 log so preflight can see what ElevenLabs sent", async () => {
    await h.call(controlTurn(issue().nonce), { "xi-api-key": SECRET });
    expect(h.logs[0]).toContain("auth-like headers=[xi-api-key]");
  });

  it("does not consume the nonce on a 401", async () => {
    const { nonce } = issue();
    await h.call(controlTurn(nonce), {});
    expect((await readTurn(await h.call(controlTurn(nonce)))).kind).toBe("speech");
  });

  it("503 when no secret is configured", async () => {
    const response = await handleChatCompletion(
      chatRequest(controlTurn(issue().nonce), { authorization: `Bearer ${SECRET}` }),
      { ...h.deps, secret: undefined },
      performance.now(),
    );
    expect(response.status).toBe(503);
  });
});

describe("speech", () => {
  it("streams exactly the authorised text in word groups, in OpenAI chunk format", async () => {
    const response = await h.call(controlTurn(issue().nonce));
    const turn = await readTurn(response);
    expect(turn.kind).toBe("speech");
    expect(turn.kind === "speech" && turn.text).toBe(QUESTION);
    // role chunk + ceil(11 words / 4) content chunks + stop chunk
    expect(turn.chunks).toHaveLength(1 + 3 + 1);
    expect(turn.chunks[0]?.model).toBe("vashistha-interviewer-v1");
    expect(turn.chunks[0]?.created).toBe(Math.floor(T0 / 1000));
    const contents = turn.chunks.slice(1, -1).map((c) => c.choices[0].delta["content"]);
    expect(contents).toEqual(["Why did you escalate ", "this case instead of ", "approving it outright?"]);
  });

  it("emits the byte-exact SSE framing", async () => {
    const turn = await readTurn(await h.call(controlTurn(issue({ text: "Hello there." }).nonce)));
    const id = turn.chunks[0]?.id;
    const created = Math.floor(T0 / 1000);
    const frame = (delta: string, finish: string) =>
      `data: {"id":"${id}","object":"chat.completion.chunk","created":${created},"model":"vashistha-interviewer-v1","choices":[{"index":0,"delta":${delta},"finish_reason":${finish}}]}\n\n`;
    expect(turn.raw).toBe(
      frame('{"role":"assistant","content":""}', "null") +
        frame('{"content":"Hello there."}', "null") +
        frame("{}", '"stop"') +
        "data: [DONE]\n\n",
    );
  });

  it("accepts the control message as a text-parts array and with surrounding whitespace", async () => {
    const a = issue();
    const b = issue();
    const asParts = chatBody({
      messages: [{ role: "user", content: [{ type: "text", text: formatControlMessage(a.nonce) }] }],
      extraBody: { sessionId: "s1" },
    });
    const padded = chatBody({
      messages: [{ role: "user", content: ` ${formatControlMessage(b.nonce)}\n` }],
      extraBody: { sessionId: "s1" },
    });
    expect((await readTurn(await h.call(asParts))).kind).toBe("speech");
    expect((await readTurn(await h.call(padded))).kind).toBe("speech");
  });

  it("speaks for the tutor agent with a tutor authorization", async () => {
    const turn = await readTurn(await h.call(controlTurn(issue({ agent: "tutor" }).nonce, { model: "vashistha-tutor-v3" })));
    expect(turn.kind).toBe("speech");
  });
});

describe("skip_turn", () => {
  it("emits the byte-exact tool-call stream from api-notes §4.2", async () => {
    const turn = await readTurn(
      await h.call(chatBody({ messages: [{ role: "user", content: "hello" }], extraBody: { sessionId: "s1" } })),
    );
    const id = turn.chunks[0]?.id;
    const callId = (turn.chunks[0]?.choices[0].delta["tool_calls"] as Array<{ id: string }>)[0]?.id;
    const created = Math.floor(T0 / 1000);
    const head = `{"id":"${id}","object":"chat.completion.chunk","created":${created},"model":"vashistha-interviewer-v1","choices":[{"index":0,"delta":`;
    expect(turn.raw).toBe(
      `data: ${head}{"role":"assistant","content":null,"tool_calls":[{"index":0,"id":"${callId}","type":"function","function":{"name":"skip_turn","arguments":"{\\"reason\\":\\"not_control_message\\"}"}}]},"finish_reason":null}]}\n\n` +
        `data: ${head}{},"finish_reason":"tool_calls"}]}\n\n` +
        "data: [DONE]\n\n",
    );
  });

  const user = (content: unknown) => ({ role: "user", content });
  type Case = [name: string, reason: string, body: () => unknown];
  const cases: Case[] = [
    ["invalid JSON", "malformed_request", () => "{not json"],
    ["a JSON array", "malformed_request", () => "[]"],
    ["no messages field", "malformed_request", () => ({ model: "vashistha-interviewer-v1" })],
    ["an unsupported role", "malformed_request", () => chatBody({ messages: [{ role: "developer", content: "x" }] })],
    ["a non-string model", "malformed_request", () => ({ model: 7, messages: [] })],
    ["an unknown model", "unknown_model", () => controlTurn(issue().nonce, { model: "gpt-4o" })],
    ["a near-miss model", "unknown_model", () => controlTurn(issue().nonce, { model: "vashistha-interviewer" })],
    ["no messages", "not_user_turn", () => ({ model: "vashistha-interviewer-v1", messages: [] })],
    ["a tool-result follow-up", "not_user_turn", () =>
      chatBody({
        messages: [user(formatControlMessage(issue().nonce)), { role: "tool", content: '{"ok":true}' }],
        extraBody: { sessionId: "s1" },
      })],
    ["an assistant-last history (re-engagement)", "not_user_turn", () =>
      chatBody({ messages: [user(formatControlMessage(issue().nonce)), { role: "assistant", content: QUESTION }] })],
    ["expert speech", "not_control_message", () =>
      chatBody({ messages: [user("We escalate when the amount is over ten thousand.")], extraBody: { sessionId: "s1" } })],
    ["a control message inside a sentence", "not_control_message", () =>
      chatBody({ messages: [user(`say ${formatControlMessage(issue().nonce)}`)], extraBody: { sessionId: "s1" } })],
    ["a too-short nonce", "not_control_message", () =>
      chatBody({ messages: [user("⟦ctl:abc⟧")], extraBody: { sessionId: "s1" } })],
    ["a control message with an image part", "not_control_message", () =>
      chatBody({
        messages: [user([{ type: "text", text: formatControlMessage(issue().nonce) }, { type: "image_url" }])],
        extraBody: { sessionId: "s1" },
      })],
    ["null content", "not_control_message", () => chatBody({ messages: [user(null)], extraBody: { sessionId: "s1" } })],
    ["no elevenlabs_extra_body", "missing_session", () => controlTurn(issue().nonce, { sessionId: null })],
    ["an invalid sessionId", "missing_session", () =>
      chatBody({ messages: [user(formatControlMessage(issue().nonce))], extraBody: { sessionId: "" } })],
    ["a forged nonce", "unknown_nonce", () => controlTurn("A".repeat(43))],
    ["another session's nonce", "wrong_session", () => controlTurn(issue({ sessionId: "s2" }).nonce)],
    ["the other agent's nonce", "wrong_agent", () => controlTurn(issue({ agent: "tutor" }).nonce)],
    ["a nonce from before a context change", "context_changed", () => {
      const { nonce } = issue();
      h.authorizations.bumpContextVersion("s1");
      return controlTurn(nonce);
    }],
    ["an expired nonce", "expired", () => {
      const { nonce } = issue({ ttlMs: 4_000 });
      h.advance(4_000);
      return controlTurn(nonce);
    }],
  ];

  it.each(cases)("skips %s (%s)", async (_name, reason, body) => {
    const turn = await readTurn(await h.call(body()));
    expect(turn).toMatchObject({ kind: "skip", reason });
  });

  it("re-speaks the same text on a same-nonce retry within the window (live bug #2)", async () => {
    const body = controlTurn(issue().nonce);
    expect(await readTurn(await h.call(body))).toMatchObject({ kind: "speech", text: QUESTION });
    expect(await readTurn(await h.call(body))).toMatchObject({ kind: "speech", text: QUESTION });
    h.advance(10_000); // past the re-speak window: the lost question is now re-queued, not spoken
    expect(await readTurn(await h.call(body))).toMatchObject({ kind: "skip" });
  });

  it("burns a nonce presented in the wrong context, so it cannot speak later", async () => {
    const { nonce } = issue();
    expect(await readTurn(await h.call(controlTurn(nonce, { model: "vashistha-tutor-v1" })))).toMatchObject({
      reason: "wrong_agent",
    });
    expect(await readTurn(await h.call(controlTurn(nonce)))).toMatchObject({ kind: "skip", reason: "already_used" });
  });

  it("leaves the nonce unspent when the request names no session", async () => {
    const { nonce } = issue();
    expect(await readTurn(await h.call(controlTurn(nonce, { sessionId: null })))).toMatchObject({
      reason: "missing_session",
    });
    expect((await readTurn(await h.call(controlTurn(nonce)))).kind).toBe("speech");
  });

  it("echoes an empty model when the body is malformed", async () => {
    const turn = await readTurn(await h.call("{"));
    expect(turn.chunks[0]?.model).toBe("");
  });

  it("fails closed when the ledger cannot record the decision", async () => {
    const failing: Pick<Ledger, "getSession" | "append"> = {
      getSession: (id) => h.ledger.getSession(id),
      append: () => {
        throw new Error("disk full");
      },
    };
    const response = await handleChatCompletion(
      chatRequest(controlTurn(issue().nonce), { authorization: `Bearer ${SECRET}` }),
      { ...h.deps, ledger: failing },
      performance.now(),
    );
    expect(await readTurn(response)).toMatchObject({ kind: "skip", reason: "ledger_write_failed" });
    expect(h.logs.some((line) => line.includes("ledger write failed: Error: disk full"))).toBe(true);
  });

  it("spends the nonce when the ledger fails, so a retry does not speak unrecorded", async () => {
    const body = controlTurn(issue().nonce);
    const failing: Pick<Ledger, "getSession" | "append"> = {
      getSession: (id) => h.ledger.getSession(id),
      append: () => {
        throw new Error("disk full");
      },
    };
    await readTurn(
      await handleChatCompletion(
        chatRequest(body, { authorization: `Bearer ${SECRET}` }),
        { ...h.deps, ledger: failing },
        performance.now(),
      ),
    );
    expect(await readTurn(await h.call(body))).toMatchObject({ kind: "skip", reason: "already_used" });
  });
});

describe("off-record phrase (silences without authorization)", () => {
  const PHRASE = "Okay, let's go off the record for a moment.";
  const phraseTurn = (opts: { model?: string; sessionId?: string | null; text?: string } = {}) =>
    chatBody({
      ...(opts.model ? { model: opts.model } : {}),
      messages: [
        { role: "assistant", content: QUESTION },
        { role: "user", content: opts.text ?? PHRASE },
      ],
      ...(opts.sessionId === null ? {} : { extraBody: { sessionId: opts.sessionId ?? "s1" } }),
    });

  it("emits the byte-exact set_off_record tool-call stream with no content", async () => {
    const turn = await readTurn(await h.call(phraseTurn()));
    expect(turn.kind).toBe("off_record");
    const id = turn.chunks[0]?.id;
    const callId = (turn.chunks[0]?.choices[0].delta["tool_calls"] as Array<{ id: string }>)[0]?.id;
    expect(callId).toMatch(/^call_off_record_/);
    const created = Math.floor(T0 / 1000);
    const head = `{"id":"${id}","object":"chat.completion.chunk","created":${created},"model":"vashistha-interviewer-v1","choices":[{"index":0,"delta":`;
    expect(turn.raw).toBe(
      `data: ${head}{"role":"assistant","content":null,"tool_calls":[{"index":0,"id":"${callId}","type":"function","function":{"name":"set_off_record","arguments":"{\\"offRecord\\":true}"}}]},"finish_reason":null}]}\n\n` +
        `data: ${head}{},"finish_reason":"tool_calls"}]}\n\n` +
        "data: [DONE]\n\n",
    );
  });

  it.each([
    ["the tutor", () => phraseTurn({ model: "vashistha-tutor-v2" })],
    ["a request without a session", () => phraseTurn({ sessionId: null })],
    ["a session unknown to the ledger", () => phraseTurn({ sessionId: "ghost" })],
    ["Hindi", () => phraseTurn({ text: "रिकॉर्डिंग बंद करो।" })],
    ["text parts", () =>
      chatBody({ messages: [{ role: "user", content: [{ type: "text", text: "Pause recording." }] }], extraBody: { sessionId: "s1" } })],
  ] as const)("needs no authorization (%s)", async (_name, body) => {
    expect((await readTurn(await h.call(body()))).kind).toBe("off_record");
  });

  it.each([
    ["an unknown model", "unknown_model", () => phraseTurn({ model: "gpt-4o" })],
    ["the phrase followed by a tool result", "not_user_turn", () =>
      chatBody({ messages: [{ role: "user", content: PHRASE }, { role: "tool", content: "ok" }], extraBody: { sessionId: "s1" } })],
    ["the phrase followed by an assistant turn", "not_user_turn", () =>
      chatBody({ messages: [{ role: "user", content: PHRASE }, { role: "assistant", content: "" }], extraBody: { sessionId: "s1" } })],
    ["a long answer that mentions it", "not_control_message", () =>
      phraseTurn({ text: "Honestly I would never say anything off the record about a customer in this queue." })],
  ] as const)("skips %s (%s)", async (_name, reason, body) => {
    expect(await readTurn(await h.call(body()))).toMatchObject({ kind: "skip", reason });
  });

  it("lets a valid control message speak even if a matcher would accept it", async () => {
    const turn = await handleChatCompletion(
      chatRequest(controlTurn(issue().nonce), { authorization: `Bearer ${SECRET}` }),
      { ...h.deps, offRecordPhrase: () => true },
      performance.now(),
    );
    expect(await readTurn(turn)).toMatchObject({ kind: "speech", text: QUESTION });
  });

  it("uses the configured phrase list", async () => {
    const deps = { ...h.deps, offRecordPhrase: createOffRecordPhraseMatcher(["privacy please"]) };
    const call = async (text: string) =>
      readTurn(await handleChatCompletion(chatRequest(phraseTurn({ text }), { authorization: `Bearer ${SECRET}` }), deps, performance.now()));
    expect((await call("Privacy, please!")).kind).toBe("off_record");
    expect(await call("off the record")).toMatchObject({ kind: "skip", reason: "not_control_message" });
  });

  it("records only a system_control marker, with nothing of the utterance, and no evidence", async () => {
    await h.call(phraseTurn());
    const entries = h.ledger.list("s1");
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({
      source: "system_control",
      kind: "privacy.phrase_detected",
      parentIds: [],
      privacyEpoch: 0,
      payload: { agent: "interviewer", tool: "set_off_record" },
    });
    expect(entries[0]?.traceId).toMatch(/^chatcmpl-/);
    expect(h.ledger.evidence("s1")).toEqual([]);
    const stored = JSON.stringify(entries).toLowerCase();
    const logged = h.logs.join("\n").toLowerCase();
    for (const text of [stored, logged]) {
      expect(text).not.toContain("off the record");
      expect(text).not.toContain("moment");
    }
    expect(h.logs.at(-1)).toContain('"decision":"set_off_record"');
    expect(h.logs.at(-1)).toContain('"recorded":true');
  });

  it("still silences when the ledger cannot record the marker", async () => {
    const failing: Pick<Ledger, "getSession" | "append"> = {
      getSession: (id) => h.ledger.getSession(id),
      append: () => {
        throw new Error("disk full");
      },
    };
    const response = await handleChatCompletion(
      chatRequest(phraseTurn(), { authorization: `Bearer ${SECRET}` }),
      { ...h.deps, ledger: failing },
      performance.now(),
    );
    expect((await readTurn(response)).kind).toBe("off_record");
    expect(h.logs.some((line) => line.includes("ledger write failed: Error: disk full"))).toBe(true);
  });

  it("is idempotent: a retry of the same request silences again and adds one more marker", async () => {
    const body = phraseTurn();
    expect((await readTurn(await h.call(body))).kind).toBe("off_record");
    expect((await readTurn(await h.call(body))).kind).toBe("off_record");
    expect(h.ledger.list("s1", { kinds: ["privacy.phrase_detected"] })).toHaveLength(2);
  });
});

describe("retries (ElevenLabs retries the same custom LLM on errors, timeouts and empty responses)", () => {
  async function readFirstChunk(response: Response): Promise<ReadableStreamDefaultReader<Uint8Array>> {
    const reader = response.body?.getReader();
    if (!reader) throw new Error("no body");
    const first = await reader.read();
    expect(new TextDecoder().decode(first.value)).toContain('"role":"assistant"');
    return reader;
  }

  it("a retry after a stream cancelled mid-speech speaks, and a further retry re-speaks within the window", async () => {
    const body = controlTurn(issue().nonce);
    const reader = await readFirstChunk(await h.call(body));
    await reader.cancel();
    expect(await readTurn(await h.call(body))).toMatchObject({ kind: "speech", text: QUESTION });
    expect(await readTurn(await h.call(body))).toMatchObject({ kind: "speech", text: QUESTION });
  });

  it("a retry after the request was aborted (client disconnect) speaks", async () => {
    const body = controlTurn(issue().nonce);
    const controller = new AbortController();
    await readFirstChunk(await h.call(body, undefined, controller.signal));
    controller.abort();
    expect(await readTurn(await h.call(body))).toMatchObject({ kind: "speech", text: QUESTION });
  });

  it("a retry after a completed stream re-speaks the same text, then is refused once the window closes", async () => {
    const body = controlTurn(issue().nonce);
    expect((await readTurn(await h.call(body))).kind).toBe("speech");
    expect(await readTurn(await h.call(body))).toMatchObject({ kind: "speech", text: QUESTION });
    h.advance(10_000); // past the re-speak window
    expect(await readTurn(await h.call(body))).toMatchObject({ kind: "skip" });
  });

  it("a concurrent duplicate skips while the first stream is in flight; a later retry re-speaks", async () => {
    const body = controlTurn(issue().nonce);
    const [first, second] = await Promise.all([h.call(body), h.call(body)]);
    if (!first || !second) throw new Error("unreachable");
    expect(await readTurn(second)).toMatchObject({ kind: "skip", reason: "in_flight" });
    expect(await readTurn(first)).toMatchObject({ kind: "speech", text: QUESTION });
    expect(await readTurn(await h.call(body))).toMatchObject({ kind: "speech", text: QUESTION });
  });

  it("an abort after completion does not hand the nonce back: a retry re-speaks the same text, never a different one", async () => {
    const body = controlTurn(issue().nonce);
    const controller = new AbortController();
    expect((await readTurn(await h.call(body, undefined, controller.signal))).kind).toBe("speech");
    controller.abort();
    expect(await readTurn(await h.call(body))).toMatchObject({ kind: "speech", text: QUESTION });
  });

  it("an aborted retry window closes at expiry", async () => {
    const auth = issue({ ttlMs: 4_000 });
    const body = controlTurn(auth.nonce);
    await (await readFirstChunk(await h.call(body))).cancel();
    h.advance(4_000);
    expect(await readTurn(await h.call(body))).toMatchObject({ kind: "skip", reason: "expired" });
  });

  it("records the abort in the ledger under the decision it interrupted", async () => {
    const body = controlTurn(issue().nonce);
    await (await readFirstChunk(await h.call(body))).cancel();
    const [, decision, aborted] = h.ledger.list("s1");
    expect(aborted).toMatchObject({
      source: "engine",
      kind: "llm.stream_aborted",
      parentIds: [decision?.id],
      payload: { questionId: "q-escalate", nonceReleased: true },
    });
    expect(h.logs.some((line) => line.includes("aborted before completion; nonce released"))).toBe(true);
  });
});

describe("ledger provenance", () => {
  it("records the control message as system_control and the decision as engine, linked by parent id", async () => {
    const auth = issue();
    await readTurn(await h.call(controlTurn(auth.nonce)));
    const [control, decision, ...rest] = h.ledger.list("s1");
    expect(rest).toEqual([]);
    expect(control).toMatchObject({
      source: "system_control",
      kind: "gate.control_message",
      parentIds: [],
      schemaVersion: 1,
      privacyEpoch: 0,
      payload: { nonceDigest: nonceDigest(auth.nonce), questionId: "q-escalate" },
    });
    expect(decision).toMatchObject({
      source: "engine",
      kind: "llm.turn_decision",
      parentIds: [control?.id],
      traceId: control?.traceId,
      payload: { decision: "speak", questionId: "q-escalate", agent: "interviewer", model: "vashistha-interviewer-v1" },
    });
    expect((decision?.payload as { handlerLatencyMs: number }).handlerLatencyMs).toBeGreaterThanOrEqual(0);
    expect(control?.traceId).toMatch(/^chatcmpl-/);
    expect(h.ledger.parents(decision?.id ?? "")).toEqual([control]);
  });

  it("keeps the control message out of evidence", async () => {
    await h.call(controlTurn(issue().nonce));
    const evidence = h.ledger.evidence("s1");
    expect(evidence.map((e) => e.kind)).toEqual(["llm.turn_decision"]);
  });

  it("records a rejected control message with its reason", async () => {
    const auth = issue({ agent: "tutor" });
    await h.call(controlTurn(auth.nonce));
    const [control, decision] = h.ledger.list("s1");
    expect(control?.payload).toEqual({ nonceDigest: nonceDigest(auth.nonce), reason: "wrong_agent" });
    expect(decision?.payload).toMatchObject({ decision: "skip_turn", reason: "wrong_agent", agent: "interviewer" });
  });

  it("records a plain turn as a decision without a control entry", async () => {
    await h.call(chatBody({ messages: [{ role: "user", content: "hello" }], extraBody: { sessionId: "s1" } }));
    const entries = h.ledger.list("s1");
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({ source: "engine", parentIds: [], payload: { decision: "skip_turn" } });
  });

  it("stamps the session's current privacy epoch", async () => {
    h.ledger.setOffRecord("s1", true, { occurredAt: T0, traceId: "t" });
    h.ledger.setOffRecord("s1", false, { occurredAt: T0, traceId: "t" });
    await h.call(controlTurn(issue().nonce));
    expect(h.ledger.list("s1", { kinds: ["llm.turn_decision"] })[0]?.privacyEpoch).toBe(2);
  });

  it("never writes the raw nonce or elevenlabs_extra_body to the ledger or the logs", async () => {
    const auth = issue();
    await h.call(controlTurn(auth.nonce));
    await h.call(controlTurn(auth.nonce));
    await h.call(chatBody({ messages: [{ role: "user", content: "x" }], extraBody: { sessionId: "s1", canary: EXTRA_CANARY } }));
    const stored = JSON.stringify(h.ledger.list("s1"));
    const logged = h.logs.join("\n");
    for (const text of [stored, logged]) {
      expect(text).not.toContain(auth.nonce);
      expect(text).not.toContain(EXTRA_CANARY);
      expect(text).not.toContain("elevenlabs_extra_body");
    }
    expect(h.logs).toHaveLength(3);
  });

  it("decides without writing when the session is not in the ledger", async () => {
    const turn = await readTurn(await h.call(controlTurn(issue({ sessionId: "ghost" }).nonce, { sessionId: "ghost" })));
    expect(turn).toMatchObject({ kind: "speech", text: QUESTION });
    expect(h.ledger.getSession("ghost")).toBeUndefined();
    expect(h.logs.at(-1)).toContain('"recorded":false');
  });
});

describe("response path is thin (live response-path hardening, bug 3)", () => {
  /** A ledger wrapper that counts and (optionally) slows its writes, to prove the handler does no fold. */
  function counting(slowMs = 0): Pick<Ledger, "getSession" | "append"> & { appends: number; getSessions: number } {
    const self = {
      appends: 0,
      getSessions: 0,
      getSession: (id: string) => {
        self.getSessions += 1;
        return h.ledger.getSession(id);
      },
      append: (entry: Parameters<Ledger["append"]>[0]) => {
        self.appends += 1;
        if (slowMs > 0) {
          const until = performance.now() + slowMs;
          while (performance.now() < until) {
            /* simulate a slow/blocked write (as a host freeze would): the handler must still do nothing else */
          }
        }
        return h.ledger.append(entry);
      },
    };
    return self;
  }

  it("a speak writes only the control message and the decision — no engine fold, no ledger scan", async () => {
    const ledger = counting();
    const response = await handleChatCompletion(chatRequest(controlTurn(issue().nonce), { authorization: `Bearer ${SECRET}` }), { ...h.deps, ledger }, performance.now());
    expect(await readTurn(response)).toMatchObject({ kind: "speech", text: QUESTION });
    expect(ledger.appends).toBe(2); // gate.control_message + llm.turn_decision; nothing that folds the engine
    expect(ledger.getSessions).toBeLessThanOrEqual(2);
  });

  it("a skip writes only the one decision", async () => {
    const ledger = counting();
    await readTurn(
      await handleChatCompletion(
        chatRequest(chatBody({ messages: [{ role: "user", content: "hello" }], extraBody: { sessionId: "s1" } }), { authorization: `Bearer ${SECRET}` }),
        { ...h.deps, ledger },
        performance.now(),
      ),
    );
    expect(ledger.appends).toBe(1);
  });

  it("returns quickly: handlerLatencyMs stays small even when the ledger write is slow", async () => {
    const ledger = counting(50);
    const received = performance.now();
    const turn = await readTurn(await handleChatCompletion(chatRequest(controlTurn(issue().nonce), { authorization: `Bearer ${SECRET}` }), { ...h.deps, ledger }, received));
    expect(turn.kind).toBe("speech");
    // handlerLatencyMs is measured to the response body being ready, before the ledger append; the slow
    // write happens after, so it does not delay the live speech path.
    const { handlerLatencyMs } = JSON.parse(h.logs.at(-1) ?? "{}") as { handlerLatencyMs?: number };
    expect(handlerLatencyMs).toBeLessThan(25);
  });
});

describe("preflight authorization", () => {
  it("authorises only the fixed question, which speaks once and then skips", async () => {
    const pre = issuePreflightAuthorization({ ledger: h.ledger, authorizations: h.authorizations, now: h.now });
    expect(pre.sessionId).toMatch(/^preflight-[0-9a-f-]{36}$/);
    expect(pre).toMatchObject({
      text: PREFLIGHT_QUESTION,
      controlMessage: formatControlMessage(pre.nonce),
      expiresAt: T0 + 60_000,
    });

    const body = chatBody({ messages: [{ role: "user", content: pre.controlMessage }], extraBody: { sessionId: pre.sessionId } });
    h.advance(59_999);
    expect(await readTurn(await h.call(body))).toMatchObject({ kind: "speech", text: PREFLIGHT_QUESTION });
    // A retry within the re-speak window speaks the same fixed question again (never a different one).
    expect(await readTurn(await h.call(body))).toMatchObject({ kind: "speech", text: PREFLIGHT_QUESTION });

    const kinds = h.ledger.list(pre.sessionId).map((e) => `${e.source}:${e.kind}`);
    expect(kinds).toEqual([
      "engine:gate.authorization_issued",
      "system_control:gate.control_message",
      "engine:llm.turn_decision",
      "system_control:gate.control_message",
      "engine:llm.turn_decision",
    ]);
    const issued = h.ledger.list(pre.sessionId)[0];
    expect(issued?.payload).toMatchObject({ questionId: PREFLIGHT_QUESTION_ID, nonceDigest: nonceDigest(pre.nonce) });
    expect(JSON.stringify(h.ledger.list(pre.sessionId))).not.toContain(pre.nonce);
  });
});
