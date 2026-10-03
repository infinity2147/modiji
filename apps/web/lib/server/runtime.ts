/**
 * The process-wide runtime, as route handlers see it. It is built once by the custom server
 * (`server.ts` → `runtime-init.ts`, run unbundled by tsx) and shared through `globalThis`, so
 * Next's route bundles never load SQLite, Drizzle or Z3 themselves: everything from
 * `@vashistha/core/server` is imported here as a type only.
 */
import type { ElevenLabsClient, Ledger, ServerEnv } from "@vashistha/core/server";
import type { AuthorizationStore } from "./authorizations";
import type { RateLimiter } from "./rate-limit";

export type CheckResult = { ok: true; ms: number } | { ok: false; error: string; ms?: number };

export type Runtime = {
  env: ServerEnv;
  ledger: Ledger;
  authorizations: AuthorizationStore;
  /** Null when ELEVENLABS_API_KEY is not set (allowed outside production). */
  elevenLabs: ElevenLabsClient | null;
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
