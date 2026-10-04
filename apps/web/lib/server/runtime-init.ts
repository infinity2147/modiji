/**
 * Composition root, imported ONLY by `server.ts`, which tsx runs unbundled. It may load what Next must
 * never bundle: SQLite with its migrations folder (resolved relative to core's own module file) and
 * the worker threads that run Z3, the hypothesis engine's question generation and frame decoding
 * (lib/server/workers). Route handlers reach the result through `getRuntime()` (runtime.ts).
 */
import { randomUUID } from "node:crypto";
import { unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { compileProcedure, exportWorkMapJson } from "@vashistha/mcp-guardrails";
import {
  CLAUDE_MODELS,
  createClaude,
  createElevenLabsClient,
  createLedger,
  loadServerEnv,
  openDatabase,
  type OpenedDatabase,
} from "@vashistha/core/server";
import { KYC_DOMAIN } from "@vashistha/core/domains/kyc";
import { ORACLE_MARKER as KYC_ORACLE_MARKER } from "@vashistha/core/domains/kyc/oracle";
import { createAuthorizationStore } from "./authorizations";
import { createCaseDeskStore } from "./casedesk/session";
import { createDebriefStore } from "./debrief/deps";
import { createDisagreementHolds, createExpertDirectory, createLedgerRulebook, teamRulebookView } from "./debrief/rulebook-store";
import { createEventLoopMonitor, createGcMonitor, readCpuThrottle } from "./event-loop";
import { createInterviewStore } from "./interview/engine-state";
import { createPerception } from "./perception/init";
import { createRateLimiter } from "./rate-limit";
import { registerRuntime, type CheckResult, type Runtime } from "./runtime";
import { createSchemaStore } from "./schema/deps";
import { createConceptReread, mediaFrameLoader } from "./schema/reread";
import { rulebookViewWithinModel } from "./schema/rulebook";
import { createEngineWorker } from "./workers/engine";
import { createVisionWorker } from "./workers/vision";
import { createZ3Worker, type Z3Worker } from "./workers/z3";

/** Markers of every hidden policy this process loads; the model wrapper refuses prompts containing any. */
const ORACLE_MARKERS = [KYC_ORACLE_MARKER];

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

/** The self-test runs in the Z3 worker, queued ahead of searches; this deadline also covers waiting for a free slot. */
async function probeZ3(z3: Z3Worker): Promise<CheckResult> {
  let timer: NodeJS.Timeout | undefined;
  const deadline = new Promise<CheckResult>((resolve) => {
    timer = setTimeout(
      () => resolve({ ok: false, error: `Z3 self-test did not finish within ${Z3_CHECK_DEADLINE_MS} ms` }),
      Z3_CHECK_DEADLINE_MS,
    );
  });
  try {
    return await Promise.race([z3.selfTest(), deadline]);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Validates the environment (throwing `EnvError`, which names variables but never values), opens the
 * database, starts the Z3, engine and vision worker threads, wires the runtime and registers it for
 * route handlers. Z3 starts warming in its worker; startup never waits for it.
 */
export function createRuntime(source: Readonly<Record<string, string | undefined>>): {
  runtime: Runtime;
  close: () => void;
} {
  const env = loadServerEnv(source);
  const opened = openDatabase({ dataDir: env.DATA_DIR });
  const ledger = createLedger(opened.db);
  // The only model client in the process: interview, debrief and perception all receive this value.
  const claude =
    env.LLM_CALLS === "off" || env.ANTHROPIC_API_KEY === undefined
      ? null
      : createClaude({ apiKey: env.ANTHROPIC_API_KEY, forbiddenMarkers: ORACLE_MARKERS });
  if (env.LLM_CALLS === "off") console.info("> LLM_CALLS=off: model calls disabled (no Anthropic client)");
  const rulebookAllModels = createLedgerRulebook(opened.sqlite);
  const team = teamRulebookView(rulebookAllModels, createDisagreementHolds(opened.sqlite));
  const rulebookState = rulebookViewWithinModel(KYC_DOMAIN, team);
  const z3 = createZ3Worker(console);
  const engine = createEngineWorker(console);
  const vision = createVisionWorker(console);
  const eventLoop = createEventLoopMonitor();
  const gc = createGcMonitor();
  const runtime: Runtime = {
    env,
    ledger,
    authorizations: createAuthorizationStore(),
    elevenLabs: env.ELEVENLABS_API_KEY === undefined ? null : createElevenLabsClient({ apiKey: env.ELEVENLABS_API_KEY }),
    claude,
    rulebook: () => rulebookState().rules,
    rulebookRevision: () => rulebookState().revision,
    rulebookState,
    rulebookAllModels,
    experts: { directory: createExpertDirectory(opened.sqlite), team, solver: z3.disagreements, store: { tail: Promise.resolve() } },
    casedesk: createCaseDeskStore(),
    // LLM_CALLS=off subsumes the vision-only switch, so the vision state reports `disabled` rather than `no_api_key`.
    perception: createPerception({ source: env.LLM_CALLS === "off" ? { ...source, VISION_EXTRACTION: "off" } : source, ledger, claude, prepare: vision.prepare }),
    interview: createInterviewStore(),
    engine: { questions: engine.questions },
    debrief: {
      solver: z3.witnesses,
      exports: { workMapJson: exportWorkMapJson, procedure: compileProcedure },
      models: { prose: CLAUDE_MODELS.prose },
      store: createDebriefStore(),
    },
    schema: {
      reread: claude === null ? null : createConceptReread(claude, mediaFrameLoader(env.DATA_DIR), console),
      store: createSchemaStore(),
    },
    tutor: { practice: z3.practice },
    voiceTokenLimiter: createRateLimiter(VOICE_TOKEN_RATE_LIMIT),
    checks: { db: () => probeDatabase(opened), dataDir: () => probeDataDir(env.DATA_DIR), z3: () => probeZ3(z3), eventLoop: eventLoop.snapshot, gc: gc.snapshot, cpuThrottle: readCpuThrottle },
  };
  registerRuntime(runtime);

  void z3.selfTest().then((result) => {
    if (result.ok) console.info(`> Z3 ready (${Math.round(result.ms)} ms)`);
    else console.error(`Z3 self-test failed at boot: ${result.error}`);
  });

  return {
    runtime,
    close: () => {
      registerRuntime(undefined);
      eventLoop.close();
      gc.close();
      void z3.close();
      void engine.close();
      void vision.close();
      opened.close();
    },
  };
}
