import {
  AGENT_ID_ENV,
  AGENT_ROLES,
  agentModelId,
  checkAgentInvariants,
  checkClientToolInvariants,
  diffDesiredVsActual,
  renderAgentBody,
  type AgentRole,
  type AgentSpec,
} from "../../../packages/core/src/server/elevenlabs-agents";
import { customLlmSecretName, DRY_RUN_SECRET_ID, dryRunToolId } from "../../../packages/core/src/server/elevenlabs-sync";
import { describeError, requireVars } from "../http";
import { normaliseBaseUrl } from "../target";
import type { CheckOutcome, Facts, PreflightContext, PreflightElevenLabs } from "../types";

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/** `conversation_config.agent.prompt.custom_llm.api_key.secret_id` as read back, if the API returns it. */
export function referencedSecretId(agent: unknown): string | null {
  let value: unknown = agent;
  for (const key of ["conversation_config", "agent", "prompt", "custom_llm", "api_key", "secret_id"]) {
    if (!isRecord(value)) return null;
    value = value[key];
  }
  return typeof value === "string" && value !== "" ? value : null;
}

/** `conversation_config.agent.prompt.tool_ids` as read back (non-string items are ignored here; the diff reports them). */
function attachedToolIds(agent: unknown): string[] {
  let value: unknown = agent;
  for (const key of ["conversation_config", "agent", "prompt", "tool_ids"]) {
    if (!isRecord(value)) return [];
    value = value[key];
  }
  return Array.isArray(value) ? value.filter((id): id is string => typeof id === "string") : [];
}

/**
 * The agent's client tools are exactly the spec's: each attached, matching its definition and safe (no pre-tool
 * speech, non-blocking); nothing else attached. Returns the problems and the attached tool ids by name.
 */
async function checkClientTools(
  client: PreflightElevenLabs,
  spec: AgentSpec,
  agent: unknown,
): Promise<{ problems: string[]; toolIds: Record<string, string> }> {
  const attached = await Promise.all(attachedToolIds(agent).map((id) => client.getTool(id)));
  const problems: string[] = [];
  const toolIds: Record<string, string> = {};
  for (const tool of spec.clientTools) {
    const actual = attached.find((t) => t.name === tool.name);
    if (actual === undefined) {
      problems.push(`client tool ${tool.name} is not attached (prompt.tool_ids); run pnpm agents:sync`);
      continue;
    }
    toolIds[tool.name] = actual.toolId;
    problems.push(
      ...diffDesiredVsActual(tool, actual.toolConfig).map((p) => `tool ${tool.name}: ${p}`),
      ...checkClientToolInvariants(actual.toolConfig, tool.name),
    );
  }
  for (const extra of attached.filter((t) => !spec.clientTools.some((tool) => tool.name === t.name))) {
    problems.push(`tool ${extra.name} (${extra.toolId}) is attached but not in the spec`);
  }
  return { problems, toolIds };
}

async function checkRole(
  ctx: Pick<PreflightContext, "loadAgentSpec">,
  client: PreflightElevenLabs,
  role: AgentRole,
  agentId: string,
  publicBaseUrl: string,
  expectedSecretIds: ReadonlySet<string> | null,
): Promise<{ problems: string[]; facts: Facts }> {
  const spec = await ctx.loadAgentSpec(role);
  const expectedModelId = agentModelId(spec);
  const agent = await client.getAgent(agentId);
  const secretId = referencedSecretId(agent);
  const tools = await checkClientTools(client, spec, agent);
  // The rendered spec is compared with the secret and tool ids the agent actually references; the references
  // themselves are checked separately (secret against CUSTOM_LLM_SECRET, tools by name and definition).
  const toolIds = Object.fromEntries(spec.clientTools.map((t) => [t.name, tools.toolIds[t.name] ?? dryRunToolId(t.name)]));
  const desired = renderAgentBody(spec, { publicBaseUrl, customLlmSecretId: secretId ?? DRY_RUN_SECRET_ID, toolIds });
  const problems = [
    ...checkAgentInvariants(agent, { publicBaseUrl, role, expectedModelId }),
    ...diffDesiredVsActual(desired, agent),
    ...tools.problems,
  ];
  if (expectedSecretIds !== null) {
    if (secretId === null) problems.push("custom_llm.api_key.secret_id is not returned by GET; cannot confirm it matches CUSTOM_LLM_SECRET");
    else if (!expectedSecretIds.has(secretId)) {
      problems.push(
        "custom_llm.api_key references a workspace secret other than the one derived from the current CUSTOM_LLM_SECRET (rotated secret? re-run pnpm agents:sync)",
      );
    }
  }
  return {
    problems,
    facts: {
      agentId,
      specVersion: spec.version,
      modelId: expectedModelId,
      secretReferenced: secretId !== null,
      clientTools: Object.entries(tools.toolIds).map(([name, id]) => `${name}=${id}`),
    },
  };
}

/**
 * Both agents exist, carry every safety invariant, match their versioned spec exactly (no dropped or normalised
 * keys), have exactly the spec's client tools (safe, as defined), and reference the workspace secret that holds the
 * current CUSTOM_LLM_SECRET.
 */
export async function checkAgents(
  ctx: Pick<PreflightContext, "env" | "createElevenLabs" | "loadAgentSpec">,
): Promise<CheckOutcome> {
  const vars = requireVars(ctx.env, ["ELEVENLABS_API_KEY", "PUBLIC_BASE_URL", ...Object.values(AGENT_ID_ENV)]);
  const publicBaseUrl = normaliseBaseUrl(vars.PUBLIC_BASE_URL);
  if (publicBaseUrl === null) return { status: "fail", detail: "PUBLIC_BASE_URL is not a valid http(s) URL" };
  const client = ctx.createElevenLabs(vars.ELEVENLABS_API_KEY);

  const problems: string[] = [];
  let expectedSecretIds: Set<string> | null = null;
  const customLlmSecret = ctx.env.CUSTOM_LLM_SECRET?.trim();
  if (customLlmSecret) {
    const name = customLlmSecretName(customLlmSecret);
    try {
      const secrets = await client.listSecrets({ search: name });
      expectedSecretIds = new Set(secrets.filter((s) => s.name === name).map((s) => s.secretId));
      if (expectedSecretIds.size === 0) problems.push(`workspace secret ${name} (derived from CUSTOM_LLM_SECRET) does not exist; run pnpm agents:sync`);
    } catch (error) {
      problems.push(`listing workspace secrets failed: ${describeError(error)}`);
    }
  } else {
    problems.push("CUSTOM_LLM_SECRET is not set; cannot confirm the agents authenticate with it");
  }

  const facts: Facts = {};
  const results = await Promise.all(
    AGENT_ROLES.map(async (role) => {
      try {
        return { role, ...(await checkRole(ctx, client, role, vars[AGENT_ID_ENV[role]], publicBaseUrl, expectedSecretIds)) };
      } catch (error) {
        return { role, problems: [describeError(error)], facts: {} };
      }
    }),
  );
  for (const r of results) {
    facts[r.role] = r.facts;
    problems.push(...r.problems.map((p) => `${r.role}: ${p}`));
  }
  if (problems.length > 0) {
    return { status: "fail", detail: `${problems.length} problem(s):\n${problems.map((p) => `- ${p}`).join("\n")}`, facts };
  }
  return {
    status: "pass",
    detail: `${results.map((r) => `${r.role} (${String(r.facts.modelId)})`).join(", ")}: invariants hold, spec matches, client tools match, secret reference current`,
    facts,
  };
}
