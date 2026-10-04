/**
 * P2 perception evaluation on a recorded fixture (format: packages/perception/FIXTURES.md).
 *
 *   pnpm --filter @vashistha/web exec tsx ../../packages/perception/scripts/eval-fixture.ts <fixtureDir> [--fake [--seed N]] [--out report.json]
 *
 * Live (default; needs ANTHROPIC_API_KEY, read from the environment or the repo-root .env): frames
 * are replayed in real time at their recorded capture times through change detector → ordered
 * queue → Claude Haiku 4.5 structured extraction → state applier, then scored against the DOM
 * events with the plan §11 thresholds. `--fake` swaps in a deterministic extractor that reads the
 * ground truth with injected noise on a simulated clock: it proves the harness, not the model.
 * Exit code: 0 all thresholds pass, 1 a threshold fails, 2 usage/setup error.
 */
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { registerHooks } from "node:module";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { KYC_DOMAIN } from "@vashistha/core/domains/kyc";
import { CASEDESK_SCREEN } from "../../../apps/web/lib/server/perception/screen-profile";
import { evaluate, formatReport, FixtureSchema, percentile } from "../src/evaluation";
import { executeRead, warmUpExtraction } from "../src/extraction";
import { decodePng } from "../src/png";
import { createRealClock, createVirtualClock, replaySession, type FrameExtractor, type ReplayFrame, type ReplayResult } from "../src/replay";
import { createFakeExtractor } from "./fake-extractor";

const ROOT_ENV_FILE = new URL("../../../.env", import.meta.url);

/**
 * Hidden-policy modules start with `import "server-only"`, which throws outside a react-server
 * resolution. This script is server-side and needs the oracle MARKER (never the policy) so the
 * Claude prompt guard can refuse a leak; resolve `server-only` as the web server does.
 */
registerHooks({
  resolve(specifier, context, nextResolve) {
    return specifier === "server-only"
      ? nextResolve(specifier, { ...context, conditions: [...context.conditions, "react-server"] })
      : nextResolve(specifier, context);
  },
});

function fail(message: string): never {
  console.error(message);
  process.exit(2);
}

const { values: args, positionals } = parseArgs({
  allowPositionals: true,
  options: { fake: { type: "boolean", default: false }, seed: { type: "string", default: "1" }, out: { type: "string" } },
});
const fixtureDir = positionals[0];
if (fixtureDir === undefined) fail("usage: eval-fixture <fixtureDir> [--fake [--seed N]] [--out report.json]");
const seed = Number(args.seed);
if (!Number.isInteger(seed)) fail("--seed must be an integer");

const fixture = FixtureSchema.parse(JSON.parse(readFileSync(join(fixtureDir, "fixture.json"), "utf8")));
if (fixture.domainId !== KYC_DOMAIN.id) fail(`fixture domain ${fixture.domainId} is not supported (only ${KYC_DOMAIN.id})`);
const domain = KYC_DOMAIN;
const frames: ReplayFrame[] = fixture.frames.map((f) => ({
  captureTime: f.captureTime,
  load: () => decodePng(readFileSync(join(fixtureDir, f.file))),
}));
const start = fixture.frames[0]?.captureTime ?? 0;

const profile = CASEDESK_SCREEN;

type ModeUsage = { requests: number; inputTokens: number; outputTokens: number; cacheReadTokens: number; latencyMs: number[] };
const emptyUsage = (): ModeUsage => ({ requests: 0, inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, latencyMs: [] });
const usage = { full: emptyUsage(), refresh: emptyUsage(), local: emptyUsage() };
/** Every live read, for diagnosis: what was asked, how long it took, what the model answered. */
const reads: Array<{ frameSeq: number; atMs: number; mode: string; latencyMs: number; inputTokens: number; outputTokens: number; output: unknown }> = [];

async function liveExtractor(): Promise<FrameExtractor> {
  if (existsSync(ROOT_ENV_FILE)) process.loadEnvFile(ROOT_ENV_FILE);
  const apiKey = process.env.ANTHROPIC_API_KEY ?? "";
  if (apiKey.trim() === "") fail("ANTHROPIC_API_KEY is not set: set it for the live Haiku run, or pass --fake to check the harness");
  const { createClaude } = await import("@vashistha/core/server");
  const { ORACLE_MARKER } = await import("@vashistha/core/domains/kyc/oracle");
  const claude = createClaude({ apiKey, forbiddenMarkers: [ORACLE_MARKER] });
  // As the server does at start-up: the output grammars are compiled before the first frame.
  await warmUpExtraction(claude, domain, profile);
  return async (read) => {
    const { reading, usage: u, latencyMs } = await executeRead(read, claude);
    const m = usage[read.mode];
    m.requests += 1;
    m.inputTokens += u.input_tokens;
    m.outputTokens += u.output_tokens;
    m.cacheReadTokens += u.cache_read_input_tokens ?? 0;
    m.latencyMs.push(Math.round(latencyMs));
    reads.push({
      frameSeq: read.context.frameSeq,
      atMs: read.context.captureTime - start,
      mode: read.mode,
      latencyMs: Math.round(latencyMs),
      inputTokens: u.input_tokens,
      outputTokens: u.output_tokens,
      output: reading.output,
    });
    return reading;
  };
}

async function run(): Promise<ReplayResult> {
  const sessionEpoch = fixture.sessionEpoch;
  if (args.fake) {
    const clock = createVirtualClock(start);
    const extract = createFakeExtractor({ domain, profile, domEvents: fixture.domEvents, clock, seed });
    return clock.run(() => replaySession({ domain, profile, sessionEpoch, frames, extract, clock }));
  }
  const extract = await liveExtractor();
  return replaySession({ domain, profile, sessionEpoch, frames, extract, clock: createRealClock(start) });
}

const result = await run();

const report = evaluate({ domain, domEvents: fixture.domEvents, vision: result.observations, frameToEventMs: result.queue.frameToApplyMs });
const dropCounts: Record<string, number> = {};
for (const d of result.dropped) dropCounts[`${d.where}:${d.reason}`] = (dropCounts[`${d.where}:${d.reason}`] ?? 0) + 1;
const q = result.queue;

console.info(
  args.fake
    ? `MODE: --fake (deterministic extractor reading DOM ground truth with injected noise, seed ${seed}). Proves the harness; NOT a vision measurement.`
    : `MODE: live — Claude Haiku 4.5 structured extraction, real-time replay.`,
);
console.info(`fixture: ${resolve(fixtureDir)} — ${fixture.frames.length} frames, ${fixture.domEvents.length} DOM events\n`);
console.info(formatReport(report));
console.info(
  `\npipeline: ${result.frames.changed}/${result.frames.total} frames changed · queue sent ${q.sent}, coalesced ${q.coalesced}, applied ${q.applied}, stale dropped ${q.staleDropped}, failed ${q.failed}`,
);
const conceptNames = [...new Set(result.concepts.map((c) => c.name))];
console.info(
  `dropped by validation: ${Object.keys(dropCounts).length === 0 ? "none" : JSON.stringify(dropCounts)} · proposed concepts: ${result.concepts.length} (${conceptNames.length} distinct names)`,
);
if (!args.fake)
  for (const [mode, m] of Object.entries(usage))
    console.info(
      `usage (${mode} reads): ${m.requests} requests, ${m.inputTokens} input tokens (${m.cacheReadTokens} cache reads), ${m.outputTokens} output tokens; request p50 ${percentile(m.latencyMs, 50) ?? "n/a"} ms, p95 ${percentile(m.latencyMs, 95) ?? "n/a"} ms`,
    );
for (const error of result.errors) console.error(`error: ${error}`);

if (args.out !== undefined) {
  const body = {
    mode: args.fake ? "fake" : "live",
    seed: args.fake ? seed : null,
    fixture: resolve(fixtureDir),
    report,
    pipeline: { frames: result.frames, queue: q, dropped: dropCounts, concepts: result.concepts, conceptNames, errors: result.errors },
    usage: args.fake ? null : usage,
    reads: args.fake ? null : reads,
  };
  writeFileSync(args.out, `${JSON.stringify(body, null, 2)}\n`);
  console.info(`\nJSON report: ${resolve(args.out)}`);
}
process.exit(report.pass ? 0 : 1);
