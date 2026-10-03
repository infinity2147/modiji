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
import { evaluate, formatReport, FixtureSchema } from "../src/evaluation";
import { buildExtractionRequest } from "../src/extraction";
import { prepareUpload } from "../src/image";
import { createRealClock, createVirtualClock, replaySession, type FrameExtractor, type ReplayFrame, type ReplayResult } from "../src/replay";
import { createFakeExtractor } from "./fake-extractor";
import { decodePng, encodePng } from "./png";

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

const usage = { requests: 0, inputTokens: 0, outputTokens: 0, cacheReadTokens: 0 };

async function liveExtractor(): Promise<FrameExtractor> {
  if (existsSync(ROOT_ENV_FILE)) process.loadEnvFile(ROOT_ENV_FILE);
  const apiKey = process.env.ANTHROPIC_API_KEY ?? "";
  if (apiKey.trim() === "") fail("ANTHROPIC_API_KEY is not set: set it for the live Haiku run, or pass --fake to check the harness");
  const { createClaude } = await import("@vashistha/core/server");
  const { ORACLE_MARKER } = await import("@vashistha/core/domains/kyc/oracle");
  const claude = createClaude({ apiKey, forbiddenMarkers: [ORACLE_MARKER] });
  const encode = (image: { width: number; height: number; data: Uint8ClampedArray<ArrayBuffer> }) => ({
    base64Png: encodePng(image).toString("base64"),
    width: image.width,
    height: image.height,
  });
  return async ({ image, bbox, ...context }) => {
    const upload = prepareUpload(image, bbox);
    const { request } = buildExtractionRequest({
      ...context,
      domain,
      frame: { ...encode(upload.frame), sourceWidth: image.width, sourceHeight: image.height },
      ...(upload.crop !== null && { crop: { ...encode(upload.crop.image), rect: upload.crop.rect } }),
    });
    const { output, usage: u } = await claude.structured(request);
    usage.requests += 1;
    usage.inputTokens += u.input_tokens;
    usage.outputTokens += u.output_tokens;
    usage.cacheReadTokens += u.cache_read_input_tokens ?? 0;
    return output;
  };
}

async function run(): Promise<ReplayResult> {
  const sessionEpoch = fixture.sessionEpoch;
  if (args.fake) {
    const clock = createVirtualClock(start);
    const extract = createFakeExtractor({ domain, domEvents: fixture.domEvents, clock, seed });
    return clock.run(() => replaySession({ domain, sessionEpoch, frames, extract, clock }));
  }
  const extract = await liveExtractor();
  return replaySession({ domain, sessionEpoch, frames, extract, clock: createRealClock(start) });
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
console.info(`dropped by validation: ${Object.keys(dropCounts).length === 0 ? "none" : JSON.stringify(dropCounts)} · proposed concepts: ${result.concepts.length}`);
if (!args.fake)
  console.info(
    `usage: ${usage.requests} requests, ${usage.inputTokens} input tokens (${usage.cacheReadTokens} cache reads), ${usage.outputTokens} output tokens`,
  );
for (const error of result.errors) console.error(`error: ${error}`);

if (args.out !== undefined) {
  const body = {
    mode: args.fake ? "fake" : "live",
    seed: args.fake ? seed : null,
    fixture: resolve(fixtureDir),
    report,
    pipeline: { frames: result.frames, queue: q, dropped: dropCounts, concepts: result.concepts, errors: result.errors },
    usage: args.fake ? null : usage,
  };
  writeFileSync(args.out, `${JSON.stringify(body, null, 2)}\n`);
  console.info(`\nJSON report: ${resolve(args.out)}`);
}
process.exit(report.pass ? 0 : 1);
