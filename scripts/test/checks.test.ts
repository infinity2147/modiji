import { describe, expect, it } from "vitest";
import { CLAUDE_MODELS } from "../../packages/core/src/server/claude";
import { renderAgentBody, type AgentRole } from "../../packages/core/src/server/elevenlabs-agents";
import { customLlmSecretName } from "../../packages/core/src/server/elevenlabs-sync";
import { checkAgents } from "../preflight/checks/agents";
import { checkAnthropic } from "../preflight/checks/anthropic";
import { checkEnv } from "../preflight/checks/env";
import { checkPermissions } from "../preflight/checks/permissions";
import { checkPublicLlm } from "../preflight/checks/public-llm";
import { checkSandbox, checkServerDeep } from "../preflight/checks/server";
import { checkToken } from "../preflight/checks/token";
import type { PreflightElevenLabs } from "../preflight/types";
import {
  ANTHROPIC_KEY,
  BASE_URL,
  ELEVEN_KEY,
  GOOD_ENV,
  SECRET,
  fakeClaude,
  fakeElevenLabs,
  fakeServer,
  makeContext,
  type FakeServerBehaviour,
} from "./support/fakes";

describe("env", () => {
  it("passes with every required variable and an https PUBLIC_BASE_URL", async () => {
    const r = await checkEnv({ env: GOOD_ENV, envFileLoaded: true });
    expect(r.status).toBe("pass");
    expect(r.detail).toContain(".env + process env");
  });

  it("fails naming missing and invalid variables, never their values", async () => {
    const env = { ...GOOD_ENV, ELEVENLABS_TUTOR_AGENT_ID: " ", CUSTOM_LLM_SECRET: "too-short-secret", PUBLIC_BASE_URL: "http://x.example" };
    const r = await checkEnv({ env, envFileLoaded: false });
    expect(r.status).toBe("fail");
    expect(r.detail).toContain("ELEVENLABS_TUTOR_AGENT_ID");
    expect(r.detail).toContain("CUSTOM_LLM_SECRET");
    expect(r.detail).toContain("PUBLIC_BASE_URL is not https");
    expect(r.detail).not.toContain("too-short-secret");
    expect(JSON.stringify(r)).not.toContain(ANTHROPIC_KEY);
  });
});

describe("anthropic", () => {
  it("validates structured output on Haiku and proves the reasoning and prose models are live", async () => {
    const claude = fakeClaude();
    const r = await checkAnthropic({ env: GOOD_ENV, createClaude: () => claude });
    expect(r.status).toBe("pass");
    expect(claude.calls).toEqual([
      `structured:${CLAUDE_MODELS.frameEvents}`,
      `text:${CLAUDE_MODELS.reasoning}:512`,
      `text:${CLAUDE_MODELS.prose}:512`,
    ]);
    expect(r.facts?.structured).toMatchObject({ output: { unknown: true, reason: "not_visible" }, usage: { cacheReadInputTokens: 0 } });
    expect(r.detail).toMatch(/cache r0\/w0/);
  });

  it("fails when the structured output does not validate", async () => {
    const r = await checkAnthropic({ env: GOOD_ENV, createClaude: () => fakeClaude({ structuredJson: { unknown: true, reason: "nope" } }) });
    expect(r.status).toBe("fail");
    expect(r.detail).toMatch(/structured output on claude-haiku/);
  });

  it("fails when a routed model is not live", async () => {
    const r = await checkAnthropic({ env: GOOD_ENV, createClaude: () => fakeClaude({ failModel: CLAUDE_MODELS.prose }) });
    expect(r.status).toBe("fail");
    expect(r.detail).toContain(`${CLAUDE_MODELS.prose}: ${CLAUDE_MODELS.prose}: 404`);
  });

  it("fails naming the variable when the key is missing", async () => {
    await expect(checkAnthropic({ env: {}, createClaude: () => fakeClaude() })).rejects.toThrow("ANTHROPIC_API_KEY");
  });
});

describe("agents", () => {
  const ctx = makeContext();
  const secretName = customLlmSecretName(SECRET);

  async function actualAgent(role: AgentRole, mutate?: (agent: Record<string, unknown>) => void): Promise<Record<string, unknown>> {
    const spec = await ctx.loadAgentSpec(role);
    const body = renderAgentBody(spec, { publicBaseUrl: BASE_URL, customLlmSecretId: "sec_current" });
    // GET returns everything we set plus server-side defaults.
    const agent: Record<string, unknown> = JSON.parse(JSON.stringify({ agent_id: `agent_${role}_1`, ...body, metadata: { created_at_unix_secs: 1 } }));
    mutate?.(agent);
    return agent;
  }

  function client(mutate?: (agent: Record<string, unknown>) => void, secrets = [{ secretId: "sec_current", name: secretName }]): PreflightElevenLabs {
    return fakeElevenLabs({
      getAgent: async (agentId) => {
        const agent = await actualAgent(agentId.includes("tutor") ? "tutor" : "interviewer", mutate);
        return { ...agent, agent_id: agentId };
      },
      listSecrets: async ({ search } = {}) => secrets.filter((s) => search === undefined || s.name.startsWith(search)),
    });
  }

  it("passes when both agents match the spec, the invariants and the current secret", async () => {
    const r = await checkAgents({ ...ctx, createElevenLabs: () => client() });
    expect(r.detail).toBe(
      "interviewer (vashistha-interviewer-v1), tutor (vashistha-tutor-v1): invariants hold, spec matches, secret reference current",
    );
    expect(r.status).toBe("pass");
  });

  it("fails listing every problem when a safety setting drifted", async () => {
    const r = await checkAgents({
      ...ctx,
      createElevenLabs: () =>
        client((agent) => {
          const cc = agent.conversation_config as { agent: { prompt: { built_in_tools: { skip_turn: Record<string, unknown> } } } };
          cc.agent.prompt.built_in_tools.skip_turn.pre_tool_speech = "auto";
        }),
    });
    expect(r.status).toBe("fail");
    expect(r.detail).toMatch(/interviewer: .*pre_tool_speech is "auto"; expected "off"/);
    expect(r.detail).toMatch(/tutor: .*pre_tool_speech/);
  });

  it("fails when the agents reference a secret other than the one derived from CUSTOM_LLM_SECRET", async () => {
    const r = await checkAgents({ ...ctx, createElevenLabs: () => client(undefined, [{ secretId: "sec_rotated", name: secretName }]) });
    expect(r.status).toBe("fail");
    expect(r.detail).toMatch(/references a workspace secret other than/);
  });

  it("fails when the agent cannot be fetched", async () => {
    const r = await checkAgents({
      ...ctx,
      createElevenLabs: () =>
        fakeElevenLabs({
          getAgent: () => Promise.reject(new Error("ElevenLabs GET /v1/convai/agents/x failed (HTTP 404)")),
          listSecrets: async () => [{ secretId: "sec_current", name: secretName }],
        }),
    });
    expect(r.status).toBe("fail");
    expect(r.detail).toContain("interviewer: ElevenLabs GET");
  });
});

describe("token", () => {
  it("mints tokens for both agents and through the public endpoint, registering every token as a secret", async () => {
    const ctx = makeContext();
    const minted: string[] = [];
    const eleven = fakeElevenLabs();
    const r = await checkToken({
      ...ctx,
      createElevenLabs: (key) => {
        expect(key).toBe(ELEVEN_KEY);
        return {
          ...eleven,
          getConversationToken: async (id) => {
            const t = await eleven.getConversationToken(id);
            minted.push(t.token);
            return t;
          },
        };
      },
    });
    expect(r.status).toBe("pass");
    expect(r.detail).toMatch(/^interviewer token \d+ ms; tutor token \d+ ms; public \/api\/voice\/token \d+ ms$/);
    for (const token of minted) expect(ctx.secrets.text(`x ${token}`)).toBe("x [redacted]");
    expect(JSON.stringify(r.facts)).toContain("conv_public_1");
  });

  it("fails when the public endpoint does not mint", async () => {
    const ctx = makeContext({ fetch: fakeServer({ voiceTokenStatus: 502 }).fetch });
    const r = await checkToken(ctx);
    expect(r.status).toBe("fail");
    expect(r.detail).toContain("returned HTTP 502 (upstream_error)");
  });
});

describe("public-llm", () => {
  const run = (behaviour: FakeServerBehaviour = {}) => {
    const server = fakeServer(behaviour);
    return { server, result: checkPublicLlm(makeContext({ fetch: server.fetch })) };
  };

  it("passes: 401s, skip_turn, exact authorised text, replay refused", async () => {
    const { server, result } = run();
    const r = await result;
    expect(r.detail).toMatch(/^401 without\/with wrong bearer; unauthorised → skip_turn/);
    expect(r.status).toBe("pass");
    expect(r.facts).toMatchObject({ model: "vashistha-interviewer-v1", skipTurn: { ok: true, reason: "not_control_message" }, speech: { ok: true }, replay: { ok: true } });
    const chat = server.requests.filter((q) => q.path === "/api/llm/chat/completions");
    expect(chat.map((q) => q.authorized)).toEqual([false, false, true, true, true]);
  });

  it("fails when an unauthenticated request is answered", async () => {
    const r = await run({ acceptMissingAuth: true }).result;
    expect(r.status).toBe("fail");
    expect(r.detail).toContain("no credentials: expected HTTP 401, got 200");
  });

  it("fails when an unauthorised turn speaks", async () => {
    const r = await run({ speakWithoutAuthorization: true }).result;
    expect(r.status).toBe("fail");
    expect(r.detail).toMatch(/unauthorised turn: expected one skip_turn tool call, got \[\]/);
    expect(r.detail).toMatch(/unauthorised turn: expected no content/);
  });

  it("fails when a replayed nonce speaks again", async () => {
    const r = await run({ allowReplay: true }).result;
    expect(r.status).toBe("fail");
    expect(r.detail).toMatch(/^replayed nonce: expected one skip_turn/);
  });

  it("refuses a plain-http target that was not an explicit loopback --target", async () => {
    const r = await checkPublicLlm(makeContext({ env: { ...GOOD_ENV, PUBLIC_BASE_URL: "http://preflight.example.org" } }));
    expect(r.status).toBe("fail");
    expect(r.detail).toMatch(/is not https/);
  });

  it("accepts an explicit loopback http --target", async () => {
    const r = await checkPublicLlm(makeContext({ cliTarget: "http://127.0.0.1:4100" }));
    expect(r.status).toBe("pass");
  });
});

describe("server-deep and sandbox", () => {
  it("passes when health is up, deep refuses anonymous callers and every probe is ok", async () => {
    const r = await checkServerDeep(makeContext());
    expect(r.status).toBe("pass");
    expect(r.detail).toBe("health 200; deep 401 without bearer; db ok 1.5 ms, dataDir ok 1.5 ms, z3 ok 1.5 ms");
  });

  it("fails naming the probe that is not ok", async () => {
    const r = await checkServerDeep(makeContext({ fetch: fakeServer({ deep: { dataDir: false } }).fetch }));
    expect(r.status).toBe("fail");
    expect(r.detail).toBe("dataDir not ok: EACCES: permission denied");
  });

  it("fails when the target is unreachable", async () => {
    await expect(checkServerDeep(makeContext({ cliTarget: "https://elsewhere.example" }))).rejects.toThrow("GET /api/health: fetch failed");
  });

  it("sandbox passes on HTML containing CaseDesk and fails otherwise", async () => {
    expect((await checkSandbox(makeContext())).status).toBe("pass");
    const r = await checkSandbox(makeContext({ fetch: fakeServer({ sandboxHtml: "<p>Not found</p>" }).fetch }));
    expect(r).toMatchObject({ status: "fail", detail: '/sandbox: page does not contain "CaseDesk"' });
  });
});

describe("permissions", () => {
  it("is informational and carries the checklist", async () => {
    const r = await checkPermissions();
    expect(r.status).toBe("info");
    expect(JSON.stringify(r.facts)).toMatch(/Also share tab audio/);
    expect(JSON.stringify(r.facts)).toMatch(/Screen Recording/);
  });
});
