import { describe, expect, it } from "vitest";
import {
  AGENT_ROLES,
  AgentSpecSchema,
  agentModelId,
  checkAgentInvariants,
  diffDesiredVsActual,
  loadAgentSpec,
  parseAgentModelId,
  renderAgentBody,
  type AgentRequestBody,
  type AgentRole,
  type AgentSpec,
} from "../src/server";

const BASE = "https://vashistha.example.com";
const SECRET_ID = "sec_abc123";
const specUrl = (role: AgentRole) => new URL(`../../../agents/${role}.json`, import.meta.url);

const specs = Object.fromEntries(
  await Promise.all(AGENT_ROLES.map(async (role) => [role, await loadAgentSpec(specUrl(role))] as const)),
) as Record<AgentRole, AgentSpec>;

const render = (spec: AgentSpec) => renderAgentBody(spec, { publicBaseUrl: BASE, customLlmSecretId: SECRET_ID });

/** The rendered desired body shaped as a GET agent response. */
const asGetResponse = (body: AgentRequestBody): Record<string, unknown> => ({
  agent_id: "agent_1",
  metadata: { created_at_unix_secs: 1 },
  ...structuredClone(body),
});

/** Sets (or, with `undefined`, deletes) a dotted path, creating objects on the way. */
function setPath(root: Record<string, unknown>, path: string, value: unknown): Record<string, unknown> {
  const keys = path.split(".");
  let node = root;
  for (const key of keys.slice(0, -1)) {
    const next = node[key];
    if (next === null || typeof next !== "object") node[key] = {};
    node = node[key] as Record<string, unknown>;
  }
  const last = keys.at(-1) ?? "";
  if (value === undefined) delete node[last];
  else node[last] = value;
  return root;
}

describe("agent specs in /agents", () => {
  it.each(AGENT_ROLES)("%s parses, renders, and leaves no placeholders", (role) => {
    const spec = specs[role];
    expect(spec.role).toBe(role);
    expect(spec.name).toBe(`vashistha-${role}`);
    const body = render(spec);
    const text = JSON.stringify(body);
    expect(text).not.toMatch(/\{\{[^{}]*\}\}/);
    expect(text).not.toContain("{{");
    expect(body.name).toBe(spec.name);
    const prompt = (body.conversation_config.agent as { prompt: Record<string, unknown> }).prompt;
    expect(prompt.custom_llm).toEqual({
      url: `${BASE}/api/llm`,
      model_id: `vashistha-${role}-v${spec.version}`,
      api_key: { secret_id: SECRET_ID },
      api_type: "chat_completions",
    });
  });

  it.each(AGENT_ROLES)("%s rendered body passes the invariants when read back unchanged", (role) => {
    const spec = specs[role];
    const actual = asGetResponse(render(spec));
    expect(checkAgentInvariants(actual, { publicBaseUrl: BASE, role, expectedModelId: agentModelId(spec) })).toEqual([]);
    expect(diffDesiredVsActual(render(spec), actual)).toEqual([]);
  });

  it("does not mutate the spec when rendering", () => {
    const before = structuredClone(specs.interviewer);
    render(specs.interviewer);
    expect(specs.interviewer).toEqual(before);
  });
});

describe("AgentSpecSchema", () => {
  const raw = () => structuredClone(specs.interviewer) as unknown as Record<string, unknown>;

  it("rejects a name that does not match the role", () => {
    const r = AgentSpecSchema.safeParse({ ...raw(), name: "vashistha-tutor" });
    expect(r.success).toBe(false);
  });

  it("rejects a model id out of step with name and version", () => {
    const r = AgentSpecSchema.safeParse({ ...raw(), version: 2 });
    expect(r.success).toBe(false);
    expect(r.error?.issues.map((i) => i.path.join("."))).toContain(
      "body.conversation_config.agent.prompt.custom_llm.model_id",
    );
  });

  it("rejects unknown keys and a non-positive version", () => {
    expect(AgentSpecSchema.safeParse({ ...raw(), extra: 1 }).success).toBe(false);
    expect(AgentSpecSchema.safeParse({ ...raw(), version: 0 }).success).toBe(false);
  });
});

describe("agent model ids", () => {
  it("round-trips and rejects foreign ids", () => {
    expect(agentModelId({ name: "vashistha-tutor", version: 3 })).toBe("vashistha-tutor-v3");
    expect(parseAgentModelId("vashistha-tutor-v3")).toEqual({ role: "tutor", version: 3 });
    expect(parseAgentModelId("vashistha-interviewer-v12")).toEqual({ role: "interviewer", version: 12 });
    for (const bad of ["gpt-4o", "vashistha-tutor-v0", "vashistha-tutor-v01", "vashistha-admin-v1", "vashistha-tutor-v1 "]) {
      expect(parseAgentModelId(bad)).toBeNull();
    }
  });
});

describe("renderAgentBody", () => {
  it("throws on a leftover placeholder and names its path", () => {
    const spec = structuredClone(specs.interviewer);
    setPath(spec.body.conversation_config, "agent.prompt.prompt", "Hello {{caller_name}}");
    setPath(spec.body.platform_settings, "x.{{KEY}}", 1);
    expect(() => render(spec)).toThrow(
      /unresolved placeholders at conversation_config\.agent\.prompt\.prompt, platform_settings\.x\.\{\{KEY\}\} \(key\)/,
    );
  });

  it.each(["http://vashistha.example.com", `${BASE}/`, `${BASE}?a=1`, "not a url"])(
    "rejects public base URL %s",
    (publicBaseUrl) => {
      expect(() => renderAgentBody(specs.interviewer, { publicBaseUrl, customLlmSecretId: SECRET_ID })).toThrow(/https/);
    },
  );

  it("rejects a malformed secret id", () => {
    for (const customLlmSecretId of ["", "{{CUSTOM_LLM_SECRET_ID}}", "a b"]) {
      expect(() => renderAgentBody(specs.interviewer, { publicBaseUrl: BASE, customLlmSecretId })).toThrow(/secret id/);
    }
  });
});

describe("checkAgentInvariants", () => {
  const options = { publicBaseUrl: BASE, role: "interviewer" as const, expectedModelId: "vashistha-interviewer-v1" };
  const p = "conversation_config.agent.prompt";
  const o = "platform_settings.overrides";

  const violations: [string, unknown][] = [
    ["name", "someone-else"],
    [`${p}.llm`, "gpt-4o"],
    [`${p}.custom_llm.url`, "https://attacker.example/api/llm"],
    [`${p}.custom_llm.model_id`, "vashistha-interviewer-v2"],
    [`${p}.backup_llm_config.preference`, "default"],
    ["conversation_config.agent.first_message", "Hello!"],
    ["conversation_config.agent.first_message", undefined],
    [`${p}.built_in_tools.skip_turn`, undefined],
    [`${p}.built_in_tools.skip_turn.pre_tool_speech`, "auto"],
    ["conversation_config.turn.soft_timeout_config.timeout_seconds", 3],
    ["conversation_config.turn.turn_eagerness", "normal"],
    ["conversation_config.tts.model_id", "eleven_flash_v2"],
    ["conversation_config.asr.provider", "elevenlabs"],
    ["conversation_config.conversation.client_events", ["audio", "user_transcript"]],
    ["platform_settings.privacy.retention_days", -1],
    ["platform_settings.privacy.retention_days", 0],
    ["platform_settings.privacy.retention_days", 1.5],
    [`${o}.custom_llm_extra_body`, false],
    [`${o}.conversation_config_override.agent.first_message`, true],
    [`${o}.conversation_config_override.agent.prompt.llm`, true],
    ["platform_settings.auth.enable_auth", false],
  ];

  it.each(violations)("flags %s = %j as exactly one problem", (path, value) => {
    const actual = setPath(asGetResponse(render(specs.interviewer)), path, value);
    const problems = checkAgentInvariants(actual, options);
    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain(path.endsWith(".skip_turn") ? `${path}.` : path);
  });

  it("tolerates an absent backup LLM config and absent client overrides", () => {
    const actual = asGetResponse(render(specs.interviewer));
    setPath(actual, `${p}.backup_llm_config`, undefined);
    setPath(actual, `${o}.conversation_config_override`, undefined);
    expect(checkAgentInvariants(actual, options)).toEqual([]);
  });

  it("reports everything for a non-object", () => {
    expect(checkAgentInvariants(null, options).length).toBeGreaterThan(10);
  });
});

describe("diffDesiredVsActual", () => {
  const desired = render(specs.interviewer);
  const actual = () => asGetResponse(desired);

  it("detects a key the API dropped", () => {
    const a = setPath(actual(), "conversation_config.agent.prompt.backup_llm_config", undefined);
    expect(diffDesiredVsActual(desired, a)).toEqual([
      'conversation_config.agent.prompt.backup_llm_config: expected an object, got missing',
    ]);
  });

  it("detects a changed leaf", () => {
    const a = setPath(actual(), "conversation_config.turn.turn_timeout", 7);
    expect(diffDesiredVsActual(desired, a)).toEqual(["conversation_config.turn.turn_timeout: expected 30, got 7"]);
  });

  it("compares primitive arrays as sets", () => {
    const events = (desired.conversation_config.conversation as { client_events: string[] }).client_events;
    const path = "conversation_config.conversation.client_events";
    expect(diffDesiredVsActual(desired, setPath(actual(), path, [...events].reverse()))).toEqual([]);
    expect(diffDesiredVsActual(desired, setPath(actual(), path, events.filter((e) => e !== "vad_score")))).toEqual([
      `${path}: missing ["vad_score"]`,
    ]);
    expect(diffDesiredVsActual(desired, setPath(actual(), path, [...events, "tentative_user_transcript"]))).toEqual([
      `${path}: unexpected ["tentative_user_transcript"]`,
    ]);
  });

  it("compares arrays of objects item by item", () => {
    expect(diffDesiredVsActual([{ a: 1 }], [{ a: 1, b: 2 }])).toEqual([]);
    expect(diffDesiredVsActual([{ a: 1 }], [{ a: 2 }])).toEqual(["[0].a: expected 1, got 2"]);
    expect(diffDesiredVsActual([{ a: 1 }], [])).toEqual(["(root): expected 1 items, got 0"]);
  });

  it("ignores extra keys the API adds", () => {
    const a = setPath(actual(), "conversation_config.tts.stability", 0.5);
    expect(diffDesiredVsActual(desired, a)).toEqual([]);
  });

  it("tolerates a withheld api_key reference but reports a different one", () => {
    const path = "conversation_config.agent.prompt.custom_llm.api_key";
    expect(diffDesiredVsActual(desired, setPath(actual(), path, undefined))).toEqual([]);
    expect(diffDesiredVsActual(desired, setPath(actual(), path, null))).toEqual([]);
    expect(diffDesiredVsActual(desired, setPath(actual(), path, { secret_id: "other" }))).toEqual([
      `${path}.secret_id: expected "${SECRET_ID}", got "other"`,
    ]);
  });
});
