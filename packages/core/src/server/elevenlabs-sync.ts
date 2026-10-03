import { createHash } from "node:crypto";
import type { AgentRequestBody, ElevenLabsClient } from "./elevenlabs";
import {
  AGENT_ID_ENV,
  agentModelId,
  checkAgentInvariants,
  diffDesiredVsActual,
  renderAgentBody,
  type AgentRole,
  type AgentSpec,
} from "./elevenlabs-agents";

/**
 * The agent-sync flow behind `pnpm agents:sync` (scripts/agents.ts is a thin CLI around it). Agents are created or
 * updated only here, from the versioned specs in `/agents`.
 */

/** Stands in for the workspace secret id in `dry-run` mode, which makes no API calls. */
export const DRY_RUN_SECRET_ID = "dry-run-secret-id";

/**
 * Name of the workspace secret holding CUSTOM_LLM_SECRET: derived from the value, so a re-run finds it without ever
 * reading it back, and a rotated secret gets a new secret (the old one is left for manual deletion). 48 bits of SHA-256
 * reveal nothing useful about a ≥32-character random secret.
 */
export function customLlmSecretName(secret: string): string {
  return `vashistha_custom_llm_${createHash("sha256").update(secret, "utf8").digest("hex").slice(0, 12)}`;
}

export type SyncClient = Pick<
  ElevenLabsClient,
  "listSecrets" | "createSecret" | "getVoice" | "createAgent" | "updateAgent" | "getAgent"
>;

export type SyncAgentsInput = {
  specs: readonly AgentSpec[];
  publicBaseUrl: string;
  customLlmSecret: string;
  /** Existing agent ids by role (from env); a role with an id is updated, one without is created. */
  agentIds: { readonly [R in AgentRole]?: string | undefined };
} & ({ mode: "dry-run" } | { mode: "apply"; client: SyncClient });

export type SyncedAgent = {
  role: AgentRole;
  envVar: (typeof AGENT_ID_ENV)[AgentRole];
  version: number;
  action: "create" | "update";
  /** Null when the agent does not exist (dry-run create, or create failed). */
  agentId: string | null;
  body: AgentRequestBody;
};

export type SyncReport = {
  /** Null when the run stopped before the secret step. */
  secret: { name: string; id: string; action: "dry-run" | "reused" | "created" } | null;
  agents: SyncedAgent[];
  /** Empty means every agent was synced and read back with the desired, safe configuration. */
  problems: string[];
};

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function voiceIdOf(body: AgentRequestBody): string | null {
  const tts = body.conversation_config.tts;
  const voiceId = tts !== null && typeof tts === "object" && !Array.isArray(tts) ? tts.voice_id : undefined;
  return typeof voiceId === "string" ? voiceId : null;
}

export async function syncAgents(input: SyncAgentsInput): Promise<SyncReport> {
  const { specs, publicBaseUrl, customLlmSecret, agentIds } = input;
  const roles = specs.map((s) => s.role);
  if (new Set(roles).size !== roles.length) throw new Error(`duplicate agent roles: ${roles.join(", ")}`);

  const secretName = customLlmSecretName(customLlmSecret);
  const render = (secretId: string): SyncedAgent[] =>
    specs.map((spec) => {
      const agentId = agentIds[spec.role] ?? null;
      return {
        role: spec.role,
        version: spec.version,
        envVar: AGENT_ID_ENV[spec.role],
        action: agentId === null ? "create" : "update",
        agentId,
        body: renderAgentBody(spec, { publicBaseUrl, customLlmSecretId: secretId }),
      };
    });

  // Rendering first validates every spec before anything in the workspace is touched.
  const planned = render(DRY_RUN_SECRET_ID);
  if (input.mode === "dry-run") {
    return {
      secret: { name: secretName, id: DRY_RUN_SECRET_ID, action: "dry-run" },
      agents: planned,
      problems: [],
    };
  }
  const { client } = input;

  const problems: string[] = [];
  const voiceIds = new Set(planned.flatMap((a) => voiceIdOf(a.body) ?? []));
  for (const voiceId of voiceIds) {
    try {
      await client.getVoice(voiceId);
    } catch (err) {
      problems.push(`voice ${voiceId} could not be verified: ${errorMessage(err)}`);
    }
  }
  if (problems.length > 0) {
    return { secret: null, agents: [], problems };
  }

  const existing = (await client.listSecrets({ search: secretName })).find((s) => s.name === secretName);
  const secret = existing
    ? { name: secretName, id: existing.secretId, action: "reused" as const }
    : { name: secretName, id: (await client.createSecret(secretName, customLlmSecret)).secretId, action: "created" as const };

  const agents = render(secret.id);
  for (const agent of agents) {
    try {
      if (agent.agentId === null) {
        agent.agentId = (await client.createAgent(agent.body)).agentId;
      } else {
        await client.updateAgent(agent.agentId, {
          ...agent.body,
          version_description: `${agent.body.name} v${agent.version} (scripts/agents.ts)`,
        });
      }
      const actual = await client.getAgent(agent.agentId);
      const expectedModelId = agentModelId({ name: agent.body.name, version: agent.version });
      const found = [
        ...diffDesiredVsActual(agent.body, actual),
        ...checkAgentInvariants(actual, { publicBaseUrl, role: agent.role, expectedModelId }),
      ];
      problems.push(...found.map((p) => `${agent.role}: ${p}`));
    } catch (err) {
      problems.push(`${agent.role}: ${errorMessage(err)}`);
    }
  }
  return { secret, agents, problems };
}
