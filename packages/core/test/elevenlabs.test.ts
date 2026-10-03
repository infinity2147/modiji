import { describe, expect, it } from "vitest";
import { createElevenLabsClient, ElevenLabsApiError, type AgentRequestBody } from "../src/server";

const KEY = "sk_fake_elevenlabs_key_do_not_leak_0123456789";

type Call = { url: URL; method: string; headers: Headers; body: unknown };

/** A fetch that records each call and answers with `respond`. */
function fakeFetch(respond: (call: Call, signal: AbortSignal | null) => Response | Promise<Response>) {
  const calls: Call[] = [];
  const fetch: typeof globalThis.fetch = async (input, init) => {
    const url = new URL(input instanceof Request ? input.url : input);
    const raw = init?.body;
    const call: Call = {
      url,
      method: init?.method ?? "GET",
      headers: new Headers(init?.headers),
      body: typeof raw === "string" ? JSON.parse(raw) : raw,
    };
    calls.push(call);
    return respond(call, init?.signal ?? null);
  };
  return { fetch, calls };
}

const json = (value: unknown, status = 200) =>
  new Response(JSON.stringify(value), { status, headers: { "content-type": "application/json" } });

function clientWith(respond: Parameters<typeof fakeFetch>[0], timeoutMs?: number) {
  const fake = fakeFetch(respond);
  const client = createElevenLabsClient({ apiKey: KEY, fetch: fake.fetch, ...(timeoutMs ? { timeoutMs } : {}) });
  return { client, calls: fake.calls };
}

async function apiError(promise: Promise<unknown>): Promise<ElevenLabsApiError> {
  try {
    await promise;
  } catch (err) {
    expect(err).toBeInstanceOf(ElevenLabsApiError);
    const e = err as ElevenLabsApiError;
    for (const text of [e.message, e.detail, JSON.stringify(e), String(e.stack)]) expect(text).not.toContain(KEY);
    return e;
  }
  throw new Error("expected ElevenLabsApiError");
}

const body: AgentRequestBody = {
  name: "vashistha-interviewer",
  conversation_config: { agent: { first_message: "" } },
  platform_settings: { privacy: { retention_days: 30 } },
};

describe("createElevenLabsClient requests", () => {
  it("mints a conversation token with the key header and agent_id query", async () => {
    const { client, calls } = clientWith(() => json({ token: "tok", conversation_id: "conv_1", extra: 1 }));
    await expect(client.getConversationToken("agent_1")).resolves.toEqual({ token: "tok", conversationId: "conv_1" });
    expect(calls).toHaveLength(1);
    const [call] = calls;
    expect(call?.method).toBe("GET");
    expect(call?.url.origin).toBe("https://api.elevenlabs.io");
    expect(call?.url.pathname).toBe("/v1/convai/conversation/token");
    expect([...(call?.url.searchParams ?? [])]).toEqual([["agent_id", "agent_1"]]);
    expect(call?.headers.get("xi-api-key")).toBe(KEY);
    expect(call?.headers.get("content-type")).toBeNull();
    expect(call?.body).toBeUndefined();
  });

  it("encodes query values and honours a custom base URL", async () => {
    const fake = fakeFetch(() => json({ token: "t", conversation_id: "c" }));
    const client = createElevenLabsClient({ apiKey: KEY, fetch: fake.fetch, baseUrl: "https://api.eu.residency.elevenlabs.io" });
    await client.getConversationToken("a&b=c");
    expect(fake.calls[0]?.url.href).toBe("https://api.eu.residency.elevenlabs.io/v1/convai/conversation/token?agent_id=a%26b%3Dc");
  });

  it("gets a signed WebSocket URL and rejects a non-wss one", async () => {
    const signed = "wss://api.elevenlabs.io/v1/convai/conversation?agent_id=agent_1&conversation_signature=sig";
    const ok = clientWith(() => json({ signed_url: signed }));
    await expect(ok.client.getSignedUrl("agent_1")).resolves.toBe(signed);
    expect(ok.calls[0]?.url.pathname).toBe("/v1/convai/conversation/get-signed-url");
    expect(ok.calls[0]?.url.searchParams.get("agent_id")).toBe("agent_1");

    const bad = clientWith(() => json({ signed_url: "https://evil.example/x" }));
    const err = await apiError(bad.client.getSignedUrl("agent_1"));
    expect(err.kind).toBe("invalid_response");
    expect(err.detail).toContain("signed_url");
  });

  it("gets an agent by encoded id and keeps the rest of the document", async () => {
    const { client, calls } = clientWith(() => json({ agent_id: "agent_1", conversation_config: { tts: {} } }));
    await expect(client.getAgent("agent/1")).resolves.toEqual({ agent_id: "agent_1", conversation_config: { tts: {} } });
    expect(calls[0]?.url.pathname).toBe("/v1/convai/agents/agent%2F1");

    const missing = clientWith(() => json({ name: "x" }));
    expect((await apiError(missing.client.getAgent("agent_1"))).detail).toContain("agent_id");
  });

  it("creates an agent with a JSON POST", async () => {
    const { client, calls } = clientWith(() => json({ agent_id: "agent_new" }));
    await expect(client.createAgent(body)).resolves.toEqual({ agentId: "agent_new" });
    expect(calls[0]?.method).toBe("POST");
    expect(calls[0]?.url.pathname).toBe("/v1/convai/agents/create");
    expect(calls[0]?.headers.get("content-type")).toBe("application/json");
    expect(calls[0]?.body).toEqual(body);
  });

  it("updates an agent with a PATCH", async () => {
    const { client, calls } = clientWith(() => json({ agent_id: "agent_1", name: "vashistha-interviewer" }));
    await client.updateAgent("agent_1", { ...body, version_description: "v1" });
    expect(calls[0]?.method).toBe("PATCH");
    expect(calls[0]?.url.pathname).toBe("/v1/convai/agents/agent_1");
    expect(calls[0]?.body).toEqual({ ...body, version_description: "v1" });
  });

  it("lists secrets across pages with a name-prefix search", async () => {
    const pages: Record<string, unknown> = {
      "": { secrets: [{ type: "stored", secret_id: "s1", name: "vashistha_a", used_by: {} }], next_cursor: "c2" },
      c2: { secrets: [{ type: "stored", secret_id: "s2", name: "vashistha_b" }], next_cursor: null },
    };
    const { client, calls } = clientWith((call) => json(pages[call.url.searchParams.get("cursor") ?? ""]));
    await expect(client.listSecrets({ search: "vashistha_" })).resolves.toEqual([
      { secretId: "s1", name: "vashistha_a" },
      { secretId: "s2", name: "vashistha_b" },
    ]);
    expect(calls.map((c) => `${c.method} ${c.url.pathname}${c.url.search}`)).toEqual([
      "GET /v1/convai/secrets?search=vashistha_",
      "GET /v1/convai/secrets?search=vashistha_&cursor=c2",
    ]);
  });

  it("stops on a repeated pagination cursor", async () => {
    const { client } = clientWith(() => json({ secrets: [], next_cursor: "same" }));
    const err = await apiError(client.listSecrets());
    expect(err.kind).toBe("invalid_response");
  });

  it("lists client tools across pages, filtered by type and name prefix", async () => {
    const tool = (id: string, name: string) => ({
      id,
      tool_config: { type: "client", name, description: "d", expects_response: false },
      access_info: {},
      usage_stats: {},
    });
    const pages: Record<string, unknown> = {
      "": { tools: [tool("t1", "set_off_record")], has_more: true, next_cursor: "c2" },
      c2: { tools: [tool("t2", "set_off_record_v0")], has_more: false, next_cursor: null },
    };
    const { client, calls } = clientWith((call) => json(pages[call.url.searchParams.get("cursor") ?? ""]));
    const tools = await client.listClientTools({ search: "set_off_record" });
    expect(tools.map((t) => [t.toolId, t.name, t.type])).toEqual([
      ["t1", "set_off_record", "client"],
      ["t2", "set_off_record_v0", "client"],
    ]);
    expect(tools[0]?.toolConfig).toMatchObject({ expects_response: false });
    expect(calls.map((c) => `${c.method} ${c.url.pathname}${c.url.search}`)).toEqual([
      "GET /v1/convai/tools?types=client&page_size=100&search=set_off_record",
      "GET /v1/convai/tools?types=client&page_size=100&search=set_off_record&cursor=c2",
    ]);
  });

  it("creates, updates and gets a tool with a tool_config body", async () => {
    const config = { type: "client", name: "set_off_record", description: "d" };
    const { client, calls } = clientWith(() => json({ id: "tool_1", tool_config: config, access_info: {}, usage_stats: {} }));
    await expect(client.createTool(config)).resolves.toMatchObject({ toolId: "tool_1", name: "set_off_record" });
    await expect(client.updateTool("tool_1", config)).resolves.toMatchObject({ toolId: "tool_1" });
    await expect(client.getTool("tool_1")).resolves.toMatchObject({ toolId: "tool_1", toolConfig: config });
    expect(calls.map((c) => `${c.method} ${c.url.pathname}`)).toEqual([
      "POST /v1/convai/tools",
      "PATCH /v1/convai/tools/tool_1",
      "GET /v1/convai/tools/tool_1",
    ]);
    expect(calls[0]?.body).toEqual({ tool_config: config });
    expect(calls[1]?.body).toEqual({ tool_config: config });
  });

  it("rejects a tool response without a tool_config name", async () => {
    const { client } = clientWith(() => json({ id: "tool_1", tool_config: { type: "client" } }));
    expect((await apiError(client.getTool("tool_1"))).kind).toBe("invalid_response");
  });

  it("creates a secret with type new", async () => {
    const { client, calls } = clientWith(() => json({ type: "stored", secret_id: "sec_1", name: "n" }));
    await expect(client.createSecret("n", "value")).resolves.toEqual({ secretId: "sec_1" });
    expect(calls[0]?.method).toBe("POST");
    expect(calls[0]?.url.pathname).toBe("/v1/convai/secrets");
    expect(calls[0]?.body).toEqual({ type: "new", name: "n", value: "value" });
  });

  it("gets a voice, and maps a missing voice to an HTTP error", async () => {
    const ok = clientWith(() => json({ voice_id: "v1", name: "Eric", category: "premade", labels: {} }));
    await expect(ok.client.getVoice("v1")).resolves.toEqual({ voiceId: "v1", name: "Eric", category: "premade" });
    expect(ok.calls[0]?.url.pathname).toBe("/v1/voices/v1");

    const gone = clientWith(() => json({ detail: { status: "voice_not_found" } }, 404));
    const err = await apiError(gone.client.getVoice("nope"));
    expect(err).toMatchObject({ kind: "http", status: 404, method: "GET", path: "/v1/voices/nope" });
    expect(err.message).toContain("voice_not_found");
  });

  it("refuses an empty API key", () => {
    expect(() => createElevenLabsClient({ apiKey: " " })).toThrow(/empty/);
  });
});

describe("createElevenLabsClient errors", () => {
  it("maps HTTP errors with a truncated, redacted body", async () => {
    const echoed = `{"detail":"bad key ${KEY}","pad":"${"x".repeat(2000)}"}`;
    const { client } = clientWith(() => new Response(echoed, { status: 401 }));
    const err = await apiError(client.getAgent("agent_1"));
    expect(err).toMatchObject({ kind: "http", status: 401, method: "GET", path: "/v1/convai/agents/agent_1" });
    expect(err.detail).toContain("[redacted]");
    expect(err.detail.length).toBeLessThanOrEqual(501);
  });

  it("redacts the secret value a 422 echoes back on createSecret, raw and JSON-escaped", async () => {
    const value = 'top/secret+value"with\\quotes=';
    const { client } = clientWith(
      (call) => json({ detail: [{ msg: "bad", input: call.body, raw: value, key: KEY }] }, 422),
    );
    const err = await apiError(client.createSecret("n", value));
    expect(err.status).toBe(422);
    expect(err.message).not.toContain(value);
    expect(err.message).not.toContain(JSON.stringify(value).slice(1, -1));
  });

  it("maps a network failure, including its cause", async () => {
    const { client } = clientWith(() => {
      throw new TypeError("fetch failed", { cause: new Error(`connect ECONNREFUSED (key ${KEY})`) });
    });
    const err = await apiError(client.getAgent("agent_1"));
    expect(err).toMatchObject({ kind: "network", status: null });
    expect(err.detail).toContain("ECONNREFUSED");
  });

  it("times out a request that never answers", async () => {
    const { client } = clientWith(
      (_call, signal) =>
        new Promise<Response>((_resolve, reject) => {
          signal?.addEventListener("abort", () => reject(signal.reason));
        }),
      20,
    );
    const err = await apiError(client.getConversationToken("agent_1"));
    expect(err).toMatchObject({ kind: "timeout", status: null, path: "/v1/convai/conversation/token?agent_id=agent_1" });
    expect(err.message).toContain("20 ms");
  });

  it("times out a response body that never finishes", async () => {
    const { client } = clientWith((_call, signal) => {
      const stream = new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(new TextEncoder().encode('{"token":'));
          signal?.addEventListener("abort", () => controller.error(signal.reason));
        },
      });
      return new Response(stream, { status: 200 });
    }, 20);
    const err = await apiError(client.getConversationToken("agent_1"));
    expect(err).toMatchObject({ kind: "timeout", status: 200 });
  });

  it("rejects a non-JSON success body", async () => {
    const { client } = clientWith(() => new Response("<html>gateway</html>", { status: 200 }));
    const err = await apiError(client.getAgent("agent_1"));
    expect(err).toMatchObject({ kind: "invalid_response", status: 200, detail: "response body is not JSON" });
  });

  it("reports schema mismatches without echoing response values", async () => {
    const { client } = clientWith(() => json({ token: "SENSITIVE_TOKEN_VALUE" }));
    const err = await apiError(client.getConversationToken("agent_1"));
    expect(err.kind).toBe("invalid_response");
    expect(err.detail).toContain("conversation_id");
    expect(err.message).not.toContain("SENSITIVE_TOKEN_VALUE");
  });
});
