/**
 * Runs the selected checks: independent ones concurrently, dependents after their dependencies pass (otherwise
 * `skip`). A check that throws fails with the (redacted) error message; nothing is ever reported as passing by
 * default.
 */
import { checkAgents } from "./checks/agents";
import { checkAnthropic } from "./checks/anthropic";
import { checkEnv } from "./checks/env";
import { checkPermissions } from "./checks/permissions";
import { checkPublicLlm } from "./checks/public-llm";
import { checkSandbox, checkServerDeep } from "./checks/server";
import { checkToken } from "./checks/token";
import { checkVoiceSkipTurn } from "./checks/voice";
import { describeError } from "./http";
import { CHECK_IDS, type CheckId, type CheckOutcome, type CheckResult, type PreflightContext } from "./types";

/** Bad command-line input (unknown check id, invalid option): the CLI exits 2. */
export class UsageError extends Error {
  override readonly name: string = "UsageError";
}

export type CheckDefinition = {
  id: CheckId;
  title: string;
  /** These must pass first; otherwise this check is skipped. */
  dependsOn?: readonly CheckId[];
  run(ctx: PreflightContext): Promise<CheckOutcome>;
};

export const CHECKS: readonly CheckDefinition[] = [
  { id: "env", title: "Environment variables", run: checkEnv },
  { id: "anthropic", title: "Anthropic structured output + routed models", run: checkAnthropic },
  { id: "agents", title: "ElevenLabs agents match spec and invariants", run: checkAgents },
  { id: "token", title: "Conversation tokens (API + public endpoint)", run: checkToken },
  { id: "public-llm", title: "Custom-LLM endpoint over the public internet", run: checkPublicLlm },
  {
    id: "voice-skip-turn",
    title: "skip_turn honoured end to end through ElevenLabs + TTS",
    dependsOn: ["public-llm"],
    run: checkVoiceSkipTurn,
  },
  { id: "server-deep", title: "DB, DATA_DIR writable and Z3 initialised", run: checkServerDeep },
  { id: "sandbox", title: "CaseDesk sandbox route", run: checkSandbox },
  { id: "permissions", title: "Demo machine mic/screen checklist", run: checkPermissions },
];

/** The ids to run for `--only`, in canonical order, with dependencies added. Throws on unknown ids. */
export function selectChecks(only: readonly string[] | undefined, checks: readonly CheckDefinition[] = CHECKS): CheckId[] {
  if (only === undefined || only.length === 0) return checks.map((c) => c.id);
  const unknown = only.filter((id) => !checks.some((c) => c.id === id));
  if (unknown.length > 0) throw new UsageError(`unknown check id(s): ${unknown.join(", ")} (known: ${CHECK_IDS.join(", ")})`);
  const selected = new Set<string>();
  const add = (id: string): void => {
    if (selected.has(id)) return;
    selected.add(id);
    for (const dep of checks.find((c) => c.id === id)?.dependsOn ?? []) add(dep);
  };
  only.forEach(add);
  return checks.filter((c) => selected.has(c.id)).map((c) => c.id);
}

export async function runChecks(
  ctx: PreflightContext,
  ids: readonly CheckId[],
  checks: readonly CheckDefinition[] = CHECKS,
  onResult?: (result: CheckResult) => void,
): Promise<CheckResult[]> {
  const definitions = checks.filter((c) => ids.includes(c.id));
  const running = new Map<CheckId, Promise<CheckResult>>();

  const runOne = async (def: CheckDefinition): Promise<CheckResult> => {
    // Yield once so every check is registered before any looks up its dependencies.
    await Promise.resolve();
    for (const dep of def.dependsOn ?? []) {
      const depResult = await running.get(dep);
      if (depResult === undefined || depResult.status !== "pass") {
        const why = depResult === undefined ? "not run" : depResult.status;
        return { id: def.id, title: def.title, status: "skip", ms: 0, detail: `depends on ${dep} (${why})` };
      }
    }
    const started = ctx.now();
    let outcome: CheckOutcome;
    try {
      outcome = await def.run(ctx);
    } catch (error) {
      outcome = { status: "fail", detail: describeError(error) };
    }
    const result: CheckResult = {
      id: def.id,
      title: def.title,
      status: outcome.status,
      ms: Math.round(ctx.now() - started),
      detail: ctx.secrets.text(outcome.detail),
    };
    if (outcome.facts !== undefined) result.facts = ctx.secrets.value(outcome.facts);
    return result;
  };

  for (const def of definitions) {
    const promise = runOne(def).then((result) => {
      onResult?.(result);
      return result;
    });
    running.set(def.id, promise);
  }
  const results = await Promise.all(definitions.map((def) => running.get(def.id)));
  return results.filter((r): r is CheckResult => r !== undefined);
}

/** 0 only if every gating check (everything but `info`) passed; a skipped check is not a pass. */
export function exitCodeFor(results: readonly CheckResult[]): 0 | 1 {
  return results.every((r) => r.status === "pass" || r.status === "info") ? 0 : 1;
}
