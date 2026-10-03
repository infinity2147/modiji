import { describe, expect, it } from "vitest";
import { createRateLimiter } from "../../lib/server/rate-limit";
import { handleVoiceToken, type VoiceTokenDeps } from "../../lib/server/voice-token";

const T0 = 1_760_000_000_000;
const UPSTREAM_DETAIL = "upstream-body-canary";

function setup(over: Partial<VoiceTokenDeps> = {}) {
  const calls: string[] = [];
  const logs: string[] = [];
  const deps: VoiceTokenDeps = {
    env: { ELEVENLABS_INTERVIEWER_AGENT_ID: "agent_interviewer", ELEVENLABS_TUTOR_AGENT_ID: "agent_tutor" },
    elevenLabs: {
      getConversationToken: async (agentId) => {
        calls.push(agentId);
        return { token: `token-for-${agentId}`, conversationId: "conv_1" };
      },
    },
    limiter: createRateLimiter({ limit: 10, windowMs: 60_000 }),
    now: () => T0,
    log: { error: (message: string) => logs.push(message) },
    ...over,
  };
  const get = (query: string, headers: Record<string, string> = {}) =>
    handleVoiceToken(new Request(`http://localhost/api/voice/token${query}`, { headers }), deps);
  return { deps, calls, logs, get };
}

describe("GET /api/voice/token", () => {
  it.each([
    ["?agent=interviewer", "agent_interviewer"],
    ["?agent=tutor", "agent_tutor"],
  ])("mints a token for %s", async (query, agentId) => {
    const { get, calls } = setup();
    const response = await get(query);
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(await response.json()).toEqual({ token: `token-for-${agentId}`, conversationId: "conv_1" });
    expect(calls).toEqual([agentId]);
  });

  it.each(["", "?agent=", "?agent=admin", "?agent=Interviewer"])("400 for agent query %j", async (query) => {
    const { get, calls } = setup();
    const response = await get(query);
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ error: "invalid_agent" });
    expect(calls).toEqual([]);
  });

  it("503 naming ELEVENLABS_API_KEY when no client is configured", async () => {
    const { get } = setup({ elevenLabs: null });
    const response = await get("?agent=interviewer");
    expect(response.status).toBe(503);
    expect(await response.json()).toMatchObject({ error: "voice_not_configured", missing: ["ELEVENLABS_API_KEY"] });
  });

  it("503 naming the agent id variable when it is not set", async () => {
    const { get, calls } = setup({ env: { ELEVENLABS_INTERVIEWER_AGENT_ID: "agent_interviewer" } });
    const response = await get("?agent=tutor");
    expect(response.status).toBe(503);
    expect(await response.json()).toMatchObject({ missing: ["ELEVENLABS_TUTOR_AGENT_ID"] });
    expect(calls).toEqual([]);
  });

  it("502 on upstream failure without passing on or logging the upstream body", async () => {
    class ElevenLabsApiError extends Error {
      override readonly name = "ElevenLabsApiError";
      readonly kind = "http";
      readonly status = 500;
    }
    const { get, logs } = setup({
      elevenLabs: {
        getConversationToken: async () => {
          throw new ElevenLabsApiError(`ElevenLabs GET /v1/convai/conversation/token failed (HTTP 500): ${UPSTREAM_DETAIL}`);
        },
      },
    });
    const response = await get("?agent=interviewer");
    expect(response.status).toBe(502);
    const text = await response.text();
    expect(JSON.parse(text)).toEqual({ error: "upstream_error" });
    expect(logs).toEqual(["[voice-token] ElevenLabs token request failed: ElevenLabsApiError kind=http status=500"]);
    expect(text + logs.join("")).not.toContain(UPSTREAM_DETAIL);
  });

  it("rate-limits per first X-Forwarded-For hop and says when to retry", async () => {
    const { get, calls } = setup();
    const from = (ip: string) => ({ "x-forwarded-for": `${ip}, 10.0.0.1` });
    for (let i = 0; i < 10; i += 1) expect((await get("?agent=interviewer", from("203.0.113.7"))).status).toBe(200);
    const limited = await get("?agent=interviewer", from("203.0.113.7"));
    expect(limited.status).toBe(429);
    expect(limited.headers.get("retry-after")).toBe("60");
    expect(await limited.json()).toEqual({ error: "rate_limited", retryAfterS: 60 });
    expect((await get("?agent=interviewer", from("198.51.100.2"))).status).toBe(200);
    expect(calls).toHaveLength(11);
  });
});

describe("createRateLimiter", () => {
  it("uses a sliding window", () => {
    const limiter = createRateLimiter({ limit: 2, windowMs: 1_000 });
    expect(limiter.take("a", 0).ok).toBe(true);
    expect(limiter.take("a", 400).ok).toBe(true);
    expect(limiter.take("a", 999)).toEqual({ ok: false, retryAfterS: 1 });
    expect(limiter.take("a", 1_000).ok).toBe(true); // the request at t=0 left the window
    expect(limiter.take("a", 1_001).ok).toBe(false);
    expect(limiter.take("a", 1_400).ok).toBe(true);
  });

  it("keeps keys independent", () => {
    const limiter = createRateLimiter({ limit: 1, windowMs: 1_000 });
    expect(limiter.take("a", 0).ok).toBe(true);
    expect(limiter.take("b", 0).ok).toBe(true);
    expect(limiter.take("a", 10).ok).toBe(false);
  });

  it("does not count rejected requests", () => {
    const limiter = createRateLimiter({ limit: 1, windowMs: 1_000 });
    expect(limiter.take("a", 0).ok).toBe(true);
    for (let t = 1; t < 1_000; t += 100) expect(limiter.take("a", t).ok).toBe(false);
    expect(limiter.take("a", 1_000).ok).toBe(true);
  });
});
