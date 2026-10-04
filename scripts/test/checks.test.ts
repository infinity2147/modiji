import { describe, expect, it } from "vitest";
import { CLAUDE_MODELS } from "../../packages/core/src/server/claude";
import { renderAgentBody, type AgentRole } from "../../packages/core/src/server/elevenlabs-agents";
import type { WorkspaceTool } from "../../packages/core/src/server/elevenlabs";
import { customLlmSecretName } from "../../packages/core/src/server/elevenlabs-sync";
import { checkAgents } from "../preflight/checks/agents";
import { checkAnthropic } from "../preflight/checks/anthropic";
import { checkEnv } from "../preflight/checks/env";
import { checkPermissions } from "../preflight/checks/permissions";
import { checkPublicLlm } from "../preflight/checks/public-llm";
import { MAX_EVENT_LOOP_P99_MS, checkSandbox, checkServerDeep } from "../preflight/checks/server";
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

  it("fails when LLM_CALLS is off, and names an invalid LLM_CALLS without echoing it", async () => {
    const off = await checkEnv({ env: { ...GOOD_ENV, LLM_CALLS: "off" }, envFileLoaded: true });
    expect(off.status).toBe("fail");
    expect(off.detail).toBe("LLM_CALLS=off disables every model call");
    const invalid = await checkEnv({ env: { ...GOOD_ENV, LLM_CALLS: "sometimes" }, envFileLoaded: true });
    expect(invalid.status).toBe("fail");
    expect(invalid.detail).toBe("invalid per loadServerEnv: LLM_CALLS");
    expect((await checkEnv({ env: { ...GOOD_ENV, LLM_CALLS: "on" }, envFileLoaded: true })).status).toBe("pass");
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

  const TOOL_ID = "tool_off_record_1";

  async function actualAgent(role: AgentRole, mutate?: (agent: Record<string, unknown>) => void): Promise<Record<string, unknown>> {
    const spec = await ctx.loadAgentSpec(role);
    const body = renderAgentBody(spec, {
      publicBaseUrl: BASE_URL,
      customLlmSecretId: "sec_current",
      toolIds: { set_off_record: TOOL_ID },
    });
    // GET returns everything we set plus server-side defaults.
    const agent: Record<string, unknown> = JSON.parse(JSON.stringify({ agent_id: `agent_${role}_1`, ...body, metadata: { created_at_unix_secs: 1 } }));
    mutate?.(agent);
    return agent;
  }

  /** The workspace tools by id, as GET /v1/convai/tools/{id} returns them (the spec'd config plus API defaults). */
  async function workspaceTools(mutate?: (config: Record<string, unknown>) => void): Promise<Map<string, WorkspaceTool>> {
    const [tool] = (await ctx.loadAgentSpec("interviewer")).clientTools;
    if (!tool) throw new Error("spec has no client tool");
    const toolConfig: Record<string, unknown> = { ...structuredClone(tool), interruption_mode: "allow", tool_call_sound: null };
    mutate?.(toolConfig);
    const extra = { name: "show_banner", type: "client", pre_tool_speech: "off", expects_response: false };
    return new Map([
      [TOOL_ID, { toolId: TOOL_ID, name: tool.name, type: "client", toolConfig }],
      ["tool_extra", { toolId: "tool_extra", name: "show_banner", type: "client", toolConfig: extra }],
    ]);
  }

  function client(
    mutate?: (agent: Record<string, unknown>) => void,
    secrets = [{ secretId: "sec_current", name: secretName }],
    mutateTool?: (config: Record<string, unknown>) => void,
  ): PreflightElevenLabs {
    return fakeElevenLabs({
      getAgent: async (agentId) => {
        const agent = await actualAgent(agentId.includes("tutor") ? "tutor" : "interviewer", mutate);
        return { ...agent, agent_id: agentId };
      },
      listSecrets: async ({ search } = {}) => secrets.filter((s) => search === undefined || s.name.startsWith(search)),
      getTool: async (toolId) => {
        const tool = (await workspaceTools(mutateTool)).get(toolId);
        if (!tool) throw new Error(`no tool ${toolId}`);
        return tool;
      },
    });
  }

  const setToolIds = (ids: unknown[]) => (agent: Record<string, unknown>) => {
    (agent.conversation_config as { agent: { prompt: Record<string, unknown> } }).agent.prompt.tool_ids = ids;
  };

  it("passes when both agents match the spec, the invariants and the current secret", async () => {
    const r = await checkAgents({ ...ctx, createElevenLabs: () => client() });
    expect(r.detail).toBe(
      "interviewer (vashistha-interviewer-v3), tutor (vashistha-tutor-v2): invariants hold, spec matches, client tools match, secret reference current",
    );
    expect(r.status).toBe("pass");
    expect(r.facts).toMatchObject({ interviewer: { clientTools: [`set_off_record=${TOOL_ID}`] } });
  });

  it("fails when the spec's client tool is not attached", async () => {
    const r = await checkAgents({ ...ctx, createElevenLabs: () => client(setToolIds([])) });
    expect(r.status).toBe("fail");
    expect(r.detail).toMatch(/interviewer: client tool set_off_record is not attached \(prompt\.tool_ids\); run pnpm agents:sync/);
    expect(r.detail).toMatch(/interviewer: conversation_config\.agent\.prompt\.tool_ids: missing \["dry-run-tool-set_off_record"\]/);
  });

  it("fails when a tool outside the spec is attached", async () => {
    const r = await checkAgents({ ...ctx, createElevenLabs: () => client(setToolIds([TOOL_ID, "tool_extra"])) });
    expect(r.status).toBe("fail");
    expect(r.detail).toContain("interviewer: tool show_banner (tool_extra) is attached but not in the spec");
  });

  it("fails when the attached tool could speak before the call or block on a response", async () => {
    const r = await checkAgents({
      ...ctx,
      createElevenLabs: () =>
        client(undefined, undefined, (config) => {
          config.pre_tool_speech = "auto";
          config.expects_response = true;
        }),
    });
    expect(r.status).toBe("fail");
    expect(r.detail).toMatch(/interviewer: tool set_off_record: pre_tool_speech is "auto"; expected "off"/);
    expect(r.detail).toMatch(/tutor: tool set_off_record: expects_response is true; expected false/);
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
    expect(r.facts).toMatchObject({ model: "vashistha-interviewer-v3", skipTurn: { ok: true, reason: "not_control_message" }, speech: { ok: true }, replay: { ok: true } });
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
    expect(r.detail).toBe("health 200; deep 401 without bearer; db ok 1.5 ms, dataDir ok 1.5 ms, z3 ok 1.5 ms; model calls on; event-loop delay p99 4 ms");
    expect(r.facts?.llmCalls).toBe("on");
    expect(r.facts?.eventLoop).toMatchObject({ p99Ms: 4, samples: 6000 });
  });

  it("fails a target whose event-loop delay p99 exceeds the bound, or that does not report it", async () => {
    const atBound = await checkServerDeep(makeContext({ fetch: fakeServer({ eventLoopP99Ms: MAX_EVENT_LOOP_P99_MS }).fetch }));
    expect(atBound.status).toBe("pass");
    const slow = await checkServerDeep(makeContext({ fetch: fakeServer({ eventLoopP99Ms: 250 }).fetch }));
    expect(slow.status).toBe("fail");
    expect(slow.detail).toBe("event-loop delay p99 250 ms > 200 ms (max 750 ms, 6000 samples since boot)");
    const missing = await checkServerDeep(makeContext({ fetch: fakeServer({ eventLoopP99Ms: null }).fetch }));
    expect(missing.status).toBe("fail");
    expect(missing.detail).toContain("does not report eventLoop");
  });

  it("surfaces GC and CPU-throttle telemetry when reported, without ever failing on them", async () => {
    const r = await checkServerDeep(
      makeContext({
        fetch: fakeServer({
          gc: { count: 7, totalPauseMs: 40, maxPauseMs: 13856, sinceMs: 60_000 },
          cpuThrottle: { nrPeriods: 1000, nrThrottled: 42, throttledMs: 13800 },
        }).fetch,
      }),
    );
    expect(r.status).toBe("pass"); // a high GC pause / throttle is reported, not a failure (it is a host signal)
    expect(r.facts?.gc).toMatchObject({ maxPauseMs: 13856, count: 7 });
    expect(r.facts?.cpuThrottle).toMatchObject({ nrThrottled: 42, throttledMs: 13800 });
    expect(r.detail).toContain("GC max pause 13856 ms (7)");
    expect(r.detail).toContain("CPU throttled 42×/13800 ms");
  });

  it("reports CPU throttle as n/a when the cgroup exposes none, and omits GC when not reported", async () => {
    const r = await checkServerDeep(makeContext({ fetch: fakeServer({ cpuThrottle: null }).fetch }));
    expect(r.status).toBe("pass");
    expect(r.facts?.cpuThrottle).toBeNull();
    expect(r.detail).toContain("CPU throttle n/a");
  });

  it("fails a target that reports LLM_CALLS=off, or does not report it at all", async () => {
    const off = await checkServerDeep(makeContext({ fetch: fakeServer({ llmCalls: "off" }).fetch }));
    expect(off.status).toBe("fail");
    expect(off.detail).toBe("target runs with LLM_CALLS=off: model calls disabled");
    expect(off.facts?.llmCalls).toBe("off");
    const missing = await checkServerDeep(makeContext({ fetch: fakeServer({ llmCalls: null }).fetch }));
    expect(missing.status).toBe("fail");
    expect(missing.detail).toContain("does not report llmCalls");
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
