import { describe, expect, it } from "vitest";
import {
  AGENT_ROLES,
  DRY_RUN_SECRET_ID,
  ElevenLabsApiError,
  customLlmSecretName,
  loadAgentSpec,
  syncAgents,
  type AgentRequestBody,
  type AgentSpec,
  type SyncClient,
  type WorkspaceSecret,
} from "../src/server";

const BASE = "https://vashistha.example.com";
const SECRET = "fake-custom-llm-secret-value-0123456789-abcdef";
const SECRET_NAME = customLlmSecretName(SECRET);

const specs: AgentSpec[] = await Promise.all(
  AGENT_ROLES.map((role) => loadAgentSpec(new URL(`../../../agents/${role}.json`, import.meta.url))),
);

type FakeOptions = {
  secrets?: WorkspaceSecret[];
  missingVoice?: boolean;
  /** Applied to each agent document before GET returns it (simulates the API dropping or changing settings). */
  readBack?: (doc: Record<string, unknown>) => void;
  failCreate?: (name: string) => boolean;
};

/** In-memory ElevenLabs workspace that records every call. */
function fakeWorkspace(options: FakeOptions = {}) {
  const calls: string[] = [];
  const secrets = [...(options.secrets ?? [])];
  const agents = new Map<string, AgentRequestBody>();
  let next = 0;
  const client: SyncClient = {
    async listSecrets(opts) {
      calls.push(`listSecrets ${opts?.search ?? ""}`);
      return secrets.filter((s) => s.name.startsWith(opts?.search ?? ""));
    },
    async createSecret(name, value) {
      calls.push(`createSecret ${name}`);
      expect(value).toBe(SECRET);
      const secret = { secretId: `sec_${++next}`, name };
      secrets.push(secret);
      return { secretId: secret.secretId };
    },
    async getVoice(voiceId) {
      calls.push(`getVoice ${voiceId}`);
      if (options.missingVoice) {
        throw new ElevenLabsApiError({ kind: "http", status: 404, method: "GET", path: `/v1/voices/${voiceId}`, detail: "voice_not_found" });
      }
      return { voiceId, name: "Eric", category: "premade" };
    },
    async createAgent(body) {
      calls.push(`createAgent ${body.name}`);
      if (options.failCreate?.(body.name)) throw new Error("HTTP 500 from fake");
      const agentId = `agent_${++next}`;
      agents.set(agentId, structuredClone(body));
      return { agentId };
    },
    async updateAgent(agentId, body) {
      calls.push(`updateAgent ${agentId} ${body.version_description ?? ""}`);
      const { version_description: _ignored, ...rest } = body;
      agents.set(agentId, structuredClone(rest));
    },
    async getAgent(agentId) {
      calls.push(`getAgent ${agentId}`);
      const body = agents.get(agentId);
      if (!body) throw new Error(`no agent ${agentId}`);
      const doc: Record<string, unknown> = { agent_id: agentId, ...structuredClone(body) };
      options.readBack?.(doc);
      return { ...doc, agent_id: agentId };
    },
  };
  return { client, calls, agents, secrets };
}

const input = { specs, publicBaseUrl: BASE, customLlmSecret: SECRET };

describe("customLlmSecretName", () => {
  it("is deterministic, value-derived and does not contain the secret", () => {
    expect(SECRET_NAME).toMatch(/^vashistha_custom_llm_[0-9a-f]{12}$/);
    expect(customLlmSecretName(SECRET)).toBe(SECRET_NAME);
    expect(customLlmSecretName(`${SECRET}x`)).not.toBe(SECRET_NAME);
  });
});

describe("syncAgents dry-run", () => {
  it("renders every agent with a placeholder secret id and plans create vs update", async () => {
    const report = await syncAgents({ ...input, agentIds: { tutor: "agent_t" }, mode: "dry-run" });
    expect(report.secret).toEqual({ name: SECRET_NAME, id: DRY_RUN_SECRET_ID, action: "dry-run" });
    expect(report.problems).toEqual([]);
    expect(report.agents.map((a) => [a.role, a.action, a.agentId, a.envVar])).toEqual([
      ["interviewer", "create", null, "ELEVENLABS_INTERVIEWER_AGENT_ID"],
      ["tutor", "update", "agent_t", "ELEVENLABS_TUTOR_AGENT_ID"],
    ]);
    const text = JSON.stringify(report);
    expect(text).toContain(`"secret_id":"${DRY_RUN_SECRET_ID}"`);
    expect(text).not.toContain(SECRET);
    expect(text).not.toContain("{{");
  });

  it("validates specs before anything else", async () => {
    await expect(syncAgents({ ...input, publicBaseUrl: "http://localhost:3000", agentIds: {}, mode: "dry-run" })).rejects.toThrow(
      /https/,
    );
    await expect(syncAgents({ ...input, specs: [specs[0]!, specs[0]!], agentIds: {}, mode: "dry-run" })).rejects.toThrow(
      /duplicate/,
    );
  });
});

describe("syncAgents apply", () => {
  it("creates the secret and both agents when nothing exists yet", async () => {
    const ws = fakeWorkspace();
    const report = await syncAgents({ ...input, agentIds: {}, mode: "apply", client: ws.client });
    expect(report.problems).toEqual([]);
    expect(report.secret).toEqual({ name: SECRET_NAME, id: "sec_1", action: "created" });
    expect(ws.calls).toEqual([
      "getVoice cjVigY5qzO86Huf0OWal",
      `listSecrets ${SECRET_NAME}`,
      `createSecret ${SECRET_NAME}`,
      "createAgent vashistha-interviewer",
      "getAgent agent_2",
      "createAgent vashistha-tutor",
      "getAgent agent_3",
    ]);
    expect(report.agents.map((a) => [a.role, a.action, a.agentId])).toEqual([
      ["interviewer", "create", "agent_2"],
      ["tutor", "create", "agent_3"],
    ]);
    for (const body of ws.agents.values()) expect(JSON.stringify(body)).toContain('"secret_id":"sec_1"');
    expect(JSON.stringify(report)).not.toContain(SECRET);
  });

  it("reuses an existing secret with the exact name and updates agents that have ids", async () => {
    const ws = fakeWorkspace({
      secrets: [
        { secretId: "sec_prefix", name: `${SECRET_NAME}_old` },
        { secretId: "sec_existing", name: SECRET_NAME },
      ],
    });
    const seeded = await syncAgents({ ...input, agentIds: {}, mode: "apply", client: ws.client });
    const ids = Object.fromEntries(seeded.agents.map((a) => [a.role, a.agentId ?? ""]));
    ws.calls.length = 0;

    const report = await syncAgents({ ...input, agentIds: ids, mode: "apply", client: ws.client });
    expect(report.problems).toEqual([]);
    expect(report.secret).toEqual({ name: SECRET_NAME, id: "sec_existing", action: "reused" });
    expect(ws.calls).toEqual([
      "getVoice cjVigY5qzO86Huf0OWal",
      `listSecrets ${SECRET_NAME}`,
      `updateAgent ${ids.interviewer} vashistha-interviewer v1 (scripts/agents.ts)`,
      `getAgent ${ids.interviewer}`,
      `updateAgent ${ids.tutor} vashistha-tutor v1 (scripts/agents.ts)`,
      `getAgent ${ids.tutor}`,
    ]);
    expect(report.agents.map((a) => a.action)).toEqual(["update", "update"]);
  });

  it("creates a new secret when only a same-prefix name exists", async () => {
    const ws = fakeWorkspace({ secrets: [{ secretId: "sec_prefix", name: `${SECRET_NAME}_old` }] });
    const report = await syncAgents({ ...input, specs: [specs[0]!], agentIds: {}, mode: "apply", client: ws.client });
    expect(report.secret?.action).toBe("created");
  });

  it("fails on an unsafe setting read back from the API", async () => {
    const ws = fakeWorkspace({
      readBack: (doc) => {
        const turn = (doc.conversation_config as { turn: { soft_timeout_config: { timeout_seconds: number } } }).turn;
        turn.soft_timeout_config.timeout_seconds = 2;
      },
    });
    const report = await syncAgents({ ...input, agentIds: {}, mode: "apply", client: ws.client });
    const path = "conversation_config.turn.soft_timeout_config.timeout_seconds";
    expect(report.problems).toEqual([
      `interviewer: ${path}: expected -1, got 2`,
      `interviewer: ${path} is 2; expected -1`,
      `tutor: ${path}: expected -1, got 2`,
      `tutor: ${path} is 2; expected -1`,
    ]);
    expect(report.agents.every((a) => a.agentId !== null)).toBe(true);
  });

  it("fails on a key the API silently dropped", async () => {
    const ws = fakeWorkspace({
      readBack: (doc) => {
        delete (doc.platform_settings as { auth?: unknown }).auth;
      },
    });
    const report = await syncAgents({ ...input, specs: [specs[0]!], agentIds: {}, mode: "apply", client: ws.client });
    expect(report.problems).toEqual([
      "interviewer: platform_settings.auth: expected an object, got missing",
      "interviewer: platform_settings.auth.enable_auth is missing; expected true",
    ]);
  });

  it("stops before touching secrets or agents when the voice is unavailable", async () => {
    const ws = fakeWorkspace({ missingVoice: true });
    const report = await syncAgents({ ...input, agentIds: {}, mode: "apply", client: ws.client });
    expect(ws.calls).toEqual(["getVoice cjVigY5qzO86Huf0OWal"]);
    expect(report.secret).toBeNull();
    expect(report.agents).toEqual([]);
    expect(report.problems).toHaveLength(1);
    expect(report.problems[0]).toMatch(/voice cjVigY5qzO86Huf0OWal could not be verified.*404/);
  });

  it("keeps the ids of agents created before another agent failed", async () => {
    const ws = fakeWorkspace({ failCreate: (name) => name === "vashistha-tutor" });
    const report = await syncAgents({ ...input, agentIds: {}, mode: "apply", client: ws.client });
    expect(report.agents.map((a) => [a.role, a.agentId])).toEqual([
      ["interviewer", "agent_2"],
      ["tutor", null],
    ]);
    expect(report.problems).toEqual(["tutor: HTTP 500 from fake"]);
  });
});
