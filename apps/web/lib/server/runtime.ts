/**
 * The process-wide runtime, as route handlers see it. It is built once by the custom server
 * (`server.ts` → `runtime-init.ts`, run unbundled by tsx) and shared through `globalThis`, so
 * Next's route bundles never load SQLite, Drizzle or Z3 themselves: everything from
 * `@vashistha/core/server` is imported here as a type only. Z3 and the hypothesis engine's question
 * generation run in worker threads (lib/server/workers) that only the composition root starts.
 */
import type { ConfirmedRule, Rulebook, TeamRulebook } from "@vashistha/core";
import type { Claude, ElevenLabsClient, Ledger, ServerEnv } from "@vashistha/core/server";
import type { AccountStore } from "./auth/store";
import type { AuthorizationStore } from "./authorizations";
import type { CaseDeskStore } from "./casedesk/session";
import type { DebriefExports, DebriefModels, DebriefStore } from "./debrief/deps";
import type { ExpertRecord } from "./debrief/rulebook-store";
import type { WitnessSolver } from "./debrief/solver";
import type { DisagreementSolver } from "./disagreements/deps";
import type { CpuThrottle, EventLoopDelay, GcStats } from "./event-loop";
import type { InterviewStore } from "./interview/engine-state";
import type { QuestionGenerator } from "./interview/questions";
import type { FrameStore, ProbeResult } from "./perception/frame-store";
import type { PerceptionService } from "./perception/service";
import type { RateLimiter } from "./rate-limit";
import type { ConceptReread, SchemaStore } from "./schema/deps";
import type { PracticeSolver } from "./tutor/deps";

export type CheckResult = { ok: true; ms: number } | { ok: false; error: string; ms?: number };

export type Runtime = {
  env: ServerEnv;
  ledger: Ledger;
  authorizations: AuthorizationStore;
  /** Null when ELEVENLABS_API_KEY is not set (allowed outside production). */
  elevenLabs: ElevenLabsClient | null;
  /**
   * Null when ANTHROPIC_API_KEY is not set (allowed outside production) or LLM_CALLS=off. The process's only model
   * client: every consumer receives this value. Refuses any prompt carrying an oracle marker.
   */
  claude: Claude | null;
  /**
   * The confirmed rulebook in force now — the TEAM rulebook (plan §7.10): `rulebookFromLedger` over the
   * `rule.*` entries of every expert session, minus the decision rules held back by open disagreements
   * between experts (`teamRulebook`; guardrails are never held back), recomputed only when the ledger
   * has grown. `rulebook()` / `rulebookRevision()` read it.
   */
  rulebook: () => readonly ConfirmedRule[];
  rulebookRevision: () => number;
  /** The same fold with its history (diffs, rule entry ids). */
  rulebookState: () => Rulebook;
  /**
   * `rulebook`, `rulebookRevision` and `rulebookState` hold the rules expressible in the BASE feature
   * model (what the interlock, tutor and MCP evaluate). This is every confirmed rule, including rules over
   * concepts confirmed in an expert session; the debrief narrows it to its session's feature model.
   */
  rulebookAllModels: () => Rulebook;
  /** Two experts (plan §7.10): the expert directory, the team rulebook with its holds, and the Z3 disagreement search. */
  experts: { directory: () => ExpertRecord[]; team: () => TeamRulebook; solver: DisagreementSolver; store: { tail: Promise<void> } };
  /** CaseDesk session facts and per-session frame order. */
  casedesk: CaseDeskStore;
  /** Derived hypothesis-engine state per session (a cache over the ledger) and its serial work queues. */
  interview: InterviewStore;
  /** The hypothesis engine's heavy steps, run in the engine worker thread off the request event loop. */
  engine: { questions: QuestionGenerator };
  /**
   * Vision channel: per-session frame order and the extraction worker. `perception.cancel(sessionId,
   * epoch)` is the off-the-record hook (abandons in-flight extraction for the new epoch).
   */
  perception: PerceptionService;
  /** Redacted frames: Cloudflare R2 when configured (capped, oldest half pruned), otherwise the volume. */
  frames: FrameStore;
  /** Debrief (P5): the Z3 witness search, the deterministic exports, prose model routing and caches. */
  debrief: { solver: WitnessSolver; exports: DebriefExports; models: DebriefModels; store: DebriefStore };
  /** Schema versioning (plan §6.6): the concept re-reader (null without a model) and the backfill queues. */
  schema: { reread: ConceptReread | null; store: SchemaStore };
  /** Tutor (P6): the Z3 practice-case search (unseen boundary cases for the weakest rules). */
  tutor: { practice: PracticeSolver };
  voiceTokenLimiter: RateLimiter;
  /** Accounts and sign-ins (lib/server/auth). */
  accounts: AccountStore;
  /** Failed sign-ins per client and username; sign-ups per client. */
  authLimits: { signIn: RateLimiter; signUp: RateLimiter };
  /** Probes behind `GET /api/health/deep`. */
  checks: {
    db: () => CheckResult;
    dataDir: () => Promise<CheckResult>;
    frames: () => Promise<ProbeResult>;
    z3: () => Promise<CheckResult>;
    eventLoop: () => EventLoopDelay;
    gc: () => GcStats;
    cpuThrottle: () => CpuThrottle | null;
  };
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
