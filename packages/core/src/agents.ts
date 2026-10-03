/** Identity of our two ElevenLabs agents, shared by the agent sync script, preflight and the custom-LLM endpoint. */

export const AGENT_ROLES = ["interviewer", "tutor"] as const;
export type AgentRole = (typeof AGENT_ROLES)[number];

/** Server env variable holding each role's agent id. */
export const AGENT_ID_ENV = {
  interviewer: "ELEVENLABS_INTERVIEWER_AGENT_ID",
  tutor: "ELEVENLABS_TUTOR_AGENT_ID",
} as const;

/** `custom_llm.url` is `${PUBLIC_BASE_URL}${CUSTOM_LLM_PATH}`; ElevenLabs appends `/chat/completions` (api-notes §4.1). */
export const CUSTOM_LLM_PATH = "/api/llm";

/** `custom_llm.model_id` for a spec: tells our custom-LLM endpoint which agent (and config version) is calling. */
export function agentModelId(spec: { name: string; version: number }): string {
  return `${spec.name}-v${spec.version}`;
}

/** Inverse of `agentModelId`; null for anything that is not one of our agents' model ids. */
export function parseAgentModelId(modelId: string): { role: AgentRole; version: number } | null {
  const match = /^vashistha-(interviewer|tutor)-v([1-9]\d{0,8})$/.exec(modelId);
  const role = AGENT_ROLES.find((r) => r === match?.[1]);
  return role && match?.[2] ? { role, version: Number(match[2]) } : null;
}
