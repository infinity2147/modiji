/**
 * `pnpm agents:sync [--dry-run] [--only interviewer|tutor]`
 *
 * Creates or updates the ElevenLabs agents from the versioned specs in /agents (the only place agents are changed),
 * ensures the workspace secret holding CUSTOM_LLM_SECRET, then reads every agent back and fails on any dropped key or
 * unsafe setting. Reads .env from the repo root if present (real env vars win).
 *
 * PUBLIC_BASE_URL must be the public https URL of the deployed service: ElevenLabs calls
 * `${PUBLIC_BASE_URL}/api/llm/chat/completions` for every agent turn. `--dry-run` prints the rendered bodies (with a
 * placeholder secret id) and makes no network calls.
 */
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { createElevenLabsClient } from "../packages/core/src/server/elevenlabs";
import { AGENT_ROLES, loadAgentSpec, type AgentRole } from "../packages/core/src/server/elevenlabs-agents";
import { syncAgents } from "../packages/core/src/server/elevenlabs-sync";
import { loadServerEnv, requireEnv } from "../packages/core/src/server/env";

async function main(): Promise<number> {
  const { values } = parseArgs({
    options: { "dry-run": { type: "boolean", default: false }, only: { type: "string" } },
    strict: true,
  });
  const only = values.only;
  const roles: readonly AgentRole[] =
    only === undefined ? AGENT_ROLES : AGENT_ROLES.filter((role) => role === only);
  if (roles.length === 0) throw new Error(`--only must be one of: ${AGENT_ROLES.join(", ")}`);

  const envFile = fileURLToPath(new URL("../.env", import.meta.url));
  if (existsSync(envFile)) process.loadEnvFile(envFile);
  const env = loadServerEnv();
  const customLlmSecret = requireEnv(env, "CUSTOM_LLM_SECRET");
  const specs = await Promise.all(roles.map((role) => loadAgentSpec(new URL(`../agents/${role}.json`, import.meta.url))));
  const common = {
    specs,
    publicBaseUrl: env.PUBLIC_BASE_URL,
    customLlmSecret,
    agentIds: { interviewer: env.ELEVENLABS_INTERVIEWER_AGENT_ID, tutor: env.ELEVENLABS_TUTOR_AGENT_ID },
  };
  const report = values["dry-run"]
    ? await syncAgents({ ...common, mode: "dry-run" })
    : await syncAgents({
        ...common,
        mode: "apply",
        client: createElevenLabsClient({ apiKey: requireEnv(env, "ELEVENLABS_API_KEY") }),
      });

  if (report.secret) console.info(`custom-LLM secret ${report.secret.name}: ${report.secret.action} (id ${report.secret.id})`);
  for (const agent of report.agents) {
    if (values["dry-run"]) {
      console.info(`\n# ${agent.role}: would ${agent.action}${agent.agentId ? ` ${agent.agentId}` : ""}`);
      console.info(JSON.stringify(agent.body, null, 2));
    } else {
      console.info(`${agent.role}: ${agent.agentId ? `${agent.action} ${agent.agentId}` : `${agent.action} failed`}`);
    }
  }
  if (!values["dry-run"]) {
    const lines = report.agents.flatMap((a) => (a.agentId ? [`${a.envVar}=${a.agentId}`] : []));
    if (lines.length > 0) console.info(`\nSet in Railway and .env (ids are not secrets):\n${lines.join("\n")}`);
  }
  if (report.problems.length > 0) {
    console.error(`\n${report.problems.length} problem(s):\n${report.problems.map((p) => `  - ${p}`).join("\n")}`);
    return 1;
  }
  return 0;
}

main().then(
  (code) => {
    process.exitCode = code;
  },
  (err: unknown) => {
    console.error(err instanceof Error ? err.message : String(err));
    process.exitCode = 1;
  },
);
