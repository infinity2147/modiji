/**
 * The process-wide runtime, as route handlers see it. It is built once by the custom server
 * (`server.ts` → `runtime-init.ts`, run unbundled by tsx) and shared through `globalThis`, so
 * Next's route bundles never load SQLite, Drizzle or Z3 themselves: everything from
 * `@vashistha/core/server` is imported here as a type only.
 */
import type { ConfirmedRule, Rulebook } from "@vashistha/core";
import type { Claude, ElevenLabsClient, Ledger, ServerEnv } from "@vashistha/core/server";
import type { AuthorizationStore } from "./authorizations";
import type { CaseDeskStore } from "./casedesk/session";
import type { DebriefExports, DebriefModels, DebriefStore } from "./debrief/deps";
import type { WitnessSolver } from "./debrief/solver";
import type { InterviewStore } from "./interview/engine-state";
import type { PerceptionService } from "./perception/service";
import type { RateLimiter } from "./rate-limit";
import type { PracticeSolver } from "./tutor/deps";

export type CheckResult = { ok: true; ms: number } | { ok: false; error: string; ms?: number };

export type Runtime = {
  env: ServerEnv;
  ledger: Ledger;
  authorizations: AuthorizationStore;
  /** Null when ELEVENLABS_API_KEY is not set (allowed outside production). */
  elevenLabs: ElevenLabsClient | null;
  /** Null when ANTHROPIC_API_KEY is not set (allowed outside production). Refuses any prompt carrying an oracle marker. */
  claude: Claude | null;
  /**
   * The confirmed rulebook in force now: `rulebookFromLedger` over the `rule.*` entries of every expert
   * session, recomputed only when the ledger has grown. `rulebook()` / `rulebookRevision()` read it.
   */
  rulebook: () => readonly ConfirmedRule[];
  rulebookRevision: () => number;
  /** The same fold with its history (diffs, rule entry ids). */
  rulebookState: () => Rulebook;
  /** CaseDesk session facts and per-session frame order. */
  casedesk: CaseDeskStore;
  /** Derived hypothesis-engine state per session (a cache over the ledger) and its serial work queues. */
  interview: InterviewStore;
  /**
   * Vision channel: per-session frame order and the extraction worker. `perception.cancel(sessionId,
   * epoch)` is the off-the-record hook (abandons in-flight extraction for the new epoch).
   */
  perception: PerceptionService;
  /** Debrief (P5): the Z3 witness search, the deterministic exports, prose model routing and caches. */
  debrief: { solver: WitnessSolver; exports: DebriefExports; models: DebriefModels; store: DebriefStore };
  /** Tutor (P6): the Z3 practice-case search (unseen boundary cases for the weakest rules). */
  tutor: { practice: PracticeSolver };
  voiceTokenLimiter: RateLimiter;
  /** Probes behind `GET /api/health/deep`. */
  checks: { db: () => CheckResult; dataDir: () => Promise<CheckResult>; z3: () => Promise<CheckResult> };
};

const RUNTIME_KEY: unique symbol = Symbol.for("vashistha.runtime");
const registry = globalThis as typeof globalThis & { [RUNTIME_KEY]?: Runtime | undefined };

/** Called by runtime-init only; `undefined` unregisters on shutdown. */
export function registerRuntime(runtime: Runtime | undefined): void {
  registry[RUNTIME_KEY] = runtime;
}

export function getRuntime(): Runtime {
  const runtime = registry[RUNTIME_KEY];
  if (!runtime) {
    throw new Error(
      "Vashistha runtime is not initialised: start the app through server.ts (pnpm dev / pnpm start), not `next dev` or `next start`",
    );
  }
  return runtime;
}
