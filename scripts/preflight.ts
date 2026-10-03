/**
 * `pnpm preflight [--target <url>] [--only a,b] [--json] [--quiet-window-ms N]`
 *
 * Plan §12 go/no-go for the live demo, run against the deployed service (default target: PUBLIC_BASE_URL).
 * Checks: env, anthropic, agents, token, public-llm, voice-skip-turn (after public-llm passes), server-deep,
 * sandbox, plus the printed permissions checklist. Logic lives in scripts/preflight/; this is the thin CLI.
 *
 * Reads .env from the repo root if present (real env vars win). Exit 0 only if every check passed. Always writes a
 * redacted JSON report to docs/evidence/preflight-<timestamp>.json. Never prints keys, tokens, signed URLs or nonces.
 * `--target http://127.0.0.1:<port>` is accepted for the HTTP checks against a local production server; the voice
 * check refuses it (ElevenLabs cannot call localhost).
 */
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { createClaude } from "../packages/core/src/server/claude";
import { createElevenLabsClient } from "../packages/core/src/server/elevenlabs";
import { loadAgentSpec } from "../packages/core/src/server/elevenlabs-agents";
import { createSecretRegistry } from "./preflight/redact";
import { buildReport, formatHuman, writeReport } from "./preflight/report";
import { exitCodeFor, runChecks, selectChecks, UsageError } from "./preflight/runner";
import { resolveTarget } from "./preflight/target";
import { DEFAULT_OPTIONS, type PreflightContext } from "./preflight/types";
import { nodeWebSocketFactory } from "./preflight/voice-session";

const USAGE = "usage: pnpm preflight [--target <url>] [--only id,id] [--json] [--quiet-window-ms N]";

function positiveInt(value: string | undefined, name: string, fallback: number): number {
  if (value === undefined) return fallback;
  if (!/^\d+$/.test(value) || Number(value) <= 0) throw new UsageError(`${name} must be a positive integer (ms)`);
  return Number(value);
}

async function main(): Promise<number> {
  const { values } = parseArgs({
    options: {
      target: { type: "string" },
      only: { type: "string" },
      json: { type: "boolean", default: false },
      "quiet-window-ms": { type: "string" },
    },
    strict: true,
  });
  const ids = selectChecks(values.only?.split(",").map((s) => s.trim()).filter((s) => s !== ""));
  const options = {
    ...DEFAULT_OPTIONS,
    quietWindowMs: positiveInt(values["quiet-window-ms"], "--quiet-window-ms", DEFAULT_OPTIONS.quietWindowMs),
  };

  const envFile = fileURLToPath(new URL("../.env", import.meta.url));
  const envFileLoaded = existsSync(envFile);
  if (envFileLoaded) process.loadEnvFile(envFile);
  const env = { ...process.env };
  const secrets = createSecretRegistry([env.ANTHROPIC_API_KEY, env.ELEVENLABS_API_KEY, env.CUSTOM_LLM_SECRET]);
  const target = resolveTarget({ cliTarget: values.target, publicBaseUrl: env.PUBLIC_BASE_URL });

  const ctx: PreflightContext = {
    env,
    envFileLoaded,
    target,
    options,
    fetch: globalThis.fetch,
    WebSocket: nodeWebSocketFactory,
    createClaude: (apiKey) => createClaude({ apiKey, forbiddenMarkers: [] }),
    createElevenLabs: (apiKey) => createElevenLabsClient({ apiKey }),
    loadAgentSpec: (role) => loadAgentSpec(new URL(`../agents/${role}.json`, import.meta.url)),
    secrets,
    now: () => performance.now(),
    wallClock: Date.now,
  };

  const startedAt = Date.now();
  const started = performance.now();
  if (!values.json) {
    console.info(`preflight → ${target.ok ? target.baseUrl : `(no target: ${target.error})`}; checks: ${ids.join(", ")}\n`);
  }
  const results = await runChecks(ctx, ids);
  const exitCode = exitCodeFor(results);
  const totalMs = performance.now() - started;

  const report = buildReport({
    startedAt,
    finishedAt: Date.now(),
    target: target.ok ? target.baseUrl : null,
    options: { only: ids, quietWindowMs: options.quietWindowMs, speechTimeoutMs: options.speechTimeoutMs },
    results,
    exitCode,
    secrets,
  });
  const reportPath = await writeReport(fileURLToPath(new URL("../docs/evidence/", import.meta.url)), report, startedAt);

  if (values.json) {
    console.info(secrets.text(JSON.stringify({ ...report, reportPath }, null, 2)));
  } else {
    console.info(formatHuman(results, exitCode, totalMs, secrets, ids.includes("permissions")));
    console.info(`\nReport: ${reportPath}`);
  }
  return exitCode;
}

main().then(
  (code) => {
    process.exitCode = code;
  },
  (err: unknown) => {
    const message = err instanceof Error ? err.message : String(err);
    const secrets = createSecretRegistry([process.env.ANTHROPIC_API_KEY, process.env.ELEVENLABS_API_KEY, process.env.CUSTOM_LLM_SECRET]);
    console.error(secrets.text(message));
    // Usage problems exit 2; anything else is an unexpected failure of the script itself.
    const usage = err instanceof UsageError || (err instanceof Error && "code" in err && String(err.code).startsWith("ERR_PARSE_ARGS"));
    if (usage) console.error(USAGE);
    process.exitCode = usage ? 2 : 1;
  },
);
