import { EnvError, loadServerEnv } from "../../../packages/core/src/server/env";
import type { CheckOutcome, PreflightContext } from "../types";

/** Everything the deployed service and this script need; names only are ever printed. */
export const REQUIRED_ENV = [
  "ANTHROPIC_API_KEY",
  "ELEVENLABS_API_KEY",
  "ELEVENLABS_INTERVIEWER_AGENT_ID",
  "ELEVENLABS_TUTOR_AGENT_ID",
  "CUSTOM_LLM_SECRET",
  "PUBLIC_BASE_URL",
] as const;

/**
 * `.env` (loaded by the CLI) plus the shell, validated by the server's own `loadServerEnv`. DATA_DIR belongs to the
 * server (checked remotely by `server-deep`), so a placeholder stands in when it is unset here. `LLM_CALLS=off` (the
 * hermetic e2e switch) fails: this env is meant to mirror the deployment's. Whether the deployed target itself runs with
 * model calls on is checked by `server-deep`, which reads it from `/api/health/deep`.
 */
export async function checkEnv(ctx: Pick<PreflightContext, "env" | "envFileLoaded">): Promise<CheckOutcome> {
  const problems: string[] = [];
  try {
    loadServerEnv({ ...ctx.env, DATA_DIR: ctx.env.DATA_DIR?.trim() || "/unused-by-preflight" });
  } catch (error) {
    if (!(error instanceof EnvError)) throw error;
    problems.push(`invalid per loadServerEnv: ${error.variables.join(", ")}`);
  }
  const missing = REQUIRED_ENV.filter((name) => (ctx.env[name]?.trim() ?? "") === "");
  if (missing.length > 0) problems.push(`missing: ${missing.join(", ")}`);
  if (ctx.env.LLM_CALLS?.trim() === "off") problems.push("LLM_CALLS=off disables every model call");
  const publicBaseUrl = ctx.env.PUBLIC_BASE_URL?.trim();
  if (publicBaseUrl && !/^https:\/\//i.test(publicBaseUrl)) problems.push("PUBLIC_BASE_URL is not https");

  const source = ctx.envFileLoaded ? ".env + process env" : "process env (no .env file)";
  const facts = { source, required: [...REQUIRED_ENV], missing: [...missing] };
  if (problems.length > 0) return { status: "fail", detail: problems.join("; "), facts };
  return { status: "pass", detail: `${REQUIRED_ENV.length} required variables set, PUBLIC_BASE_URL is https (${source})`, facts };
}
