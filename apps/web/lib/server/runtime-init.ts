/**
 * Composition root, imported ONLY by `server.ts`, which tsx runs unbundled. It may load what Next must
 * never bundle: SQLite with its migrations folder (resolved relative to core's own module file) and
 * the Z3 WASM solver. Route handlers reach the result through `getRuntime()` (runtime.ts).
 */
import { randomUUID } from "node:crypto";
import { unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  createElevenLabsClient,
  createLedger,
  loadServerEnv,
  openDatabase,
  type OpenedDatabase,
} from "@vashistha/core/server";
import { z3SelfTest } from "@vashistha/solver";
import { createAuthorizationStore } from "./authorizations";
import { createRateLimiter } from "./rate-limit";
import { registerRuntime, type CheckResult, type Runtime } from "./runtime";

/** Tokens cost agent minutes; a real session needs one or two. */
const VOICE_TOKEN_RATE_LIMIT = { limit: 10, windowMs: 60_000 };
/** First use includes WASM compilation; later self-tests take milliseconds. */
const Z3_CHECK_DEADLINE_MS = 30_000;

function msSince(started: number): number {
  return Math.round((performance.now() - started) * 100) / 100;
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * A real write in an IMMEDIATE transaction that is always rolled back: proves the write lock and
 * statement path without touching the append-only ledger or leaving anything behind.
 */
function probeDatabase(opened: OpenedDatabase): CheckResult {
  const started = performance.now();
  const rollback = new Error("health probe rollback");
  const probe = opened.sqlite.transaction(() => {
    opened.sqlite.exec("CREATE TABLE health_probe (written_at INTEGER NOT NULL)");
    opened.sqlite.prepare("INSERT INTO health_probe (written_at) VALUES (?)").run(Date.now());
    throw rollback;
  });
  try {
    probe.immediate();
    return { ok: false, error: "health probe transaction committed unexpectedly", ms: msSince(started) };
  } catch (error) {
    if (error === rollback) return { ok: true, ms: msSince(started) };
    return { ok: false, error: describe(error), ms: msSince(started) };
  }
}

async function probeDataDir(dataDir: string): Promise<CheckResult> {
  const started = performance.now();
  const file = join(dataDir, `.health-${randomUUID()}.tmp`);
  try {
    await writeFile(file, "ok", { flag: "wx" });
    await unlink(file);
    return { ok: true, ms: msSince(started) };
  } catch (error) {
    await unlink(file).catch(() => undefined);
    return { ok: false, error: describe(error), ms: msSince(started) };
  }
}

async function probeZ3(): Promise<CheckResult> {
  let timer: NodeJS.Timeout | undefined;
  const deadline = new Promise<CheckResult>((resolve) => {
    timer = setTimeout(
      () => resolve({ ok: false, error: `Z3 self-test did not finish within ${Z3_CHECK_DEADLINE_MS} ms` }),
      Z3_CHECK_DEADLINE_MS,
    );
  });
  try {
    return await Promise.race([z3SelfTest(), deadline]);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Validates the environment (throwing `EnvError`, which names variables but never values), opens the
 * database, wires the runtime and registers it for route handlers. Z3 starts warming in the
 * background; startup never waits for it.
 */
export function createRuntime(source: Readonly<Record<string, string | undefined>>): {
  runtime: Runtime;
  close: () => void;
} {
  const env = loadServerEnv(source);
  const opened = openDatabase({ dataDir: env.DATA_DIR });
  const runtime: Runtime = {
    env,
    ledger: createLedger(opened.db),
    authorizations: createAuthorizationStore(),
    elevenLabs: env.ELEVENLABS_API_KEY === undefined ? null : createElevenLabsClient({ apiKey: env.ELEVENLABS_API_KEY }),
    voiceTokenLimiter: createRateLimiter(VOICE_TOKEN_RATE_LIMIT),
    checks: { db: () => probeDatabase(opened), dataDir: () => probeDataDir(env.DATA_DIR), z3: probeZ3 },
  };
  registerRuntime(runtime);

  void z3SelfTest().then((result) => {
    if (result.ok) console.info(`> Z3 ready (${Math.round(result.ms)} ms)`);
    else console.error(`Z3 self-test failed at boot: ${result.error}`);
  });

  return {
    runtime,
    close: () => {
      registerRuntime(undefined);
      opened.close();
    },
  };
}
