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
import { performance } from "node:perf_hooks";
import { parseArgs } from "node:util";
import { createWorker, OEM, type Worker } from "tesseract.js";
import { KYC_DOMAIN } from "@vashistha/core/domains/kyc";
import { CASEDESK_SCREEN } from "../../../apps/web/lib/server/perception/screen-profile";
import { createCaseIdTracker, readCaseId, type CaseIdReaderConfig } from "../src/case-id";
import { createChangeDetector } from "../src/change-detector";
import { evaluate, formatReport, FixtureSchema, percentile } from "../src/evaluation";
import { executeRead, warmUpExtraction } from "../src/extraction";
import { clampRect, createRgba, cropRgba, rectsIntersect, type Rect, type RgbaImage } from "../src/image";
import { decodePng, encodePng } from "../src/png";
import type { OcrWord } from "../src/privacy";
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
  options: {
    fake: { type: "boolean", default: false },
    seed: { type: "string", default: "1" },
    out: { type: "string" },
    // Client case-id OCR (team P2 decision) is on for live runs; this disables it for an A/B baseline.
    "no-client-caseid": { type: "boolean", default: false },
    // Experiment: concurrent extraction requests (the product keeps 1; team P2 decision 4).
    "max-in-flight": { type: "string", default: "1" },
  },
});
const fixtureDir = positionals[0];
if (fixtureDir === undefined) fail("usage: eval-fixture <fixtureDir> [--fake [--seed N]] [--out report.json]");
const maxInFlight = Number(args["max-in-flight"]);
if (!Number.isInteger(maxInFlight) || maxInFlight < 1) fail("--max-in-flight must be a positive integer");
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

/**
 * CaseDesk client case-id reading (team P2 decision), mirroring `apps/web/lib/client/capture/browser.ts`.
 * In the live product the id is harvested from the redaction OCR the browser already runs on the
 * changed region; the harness has no browser, so it runs a dedicated Node Tesseract OCR of the header
 * band on each case-switch frame — an upper bound on the client cost (in product the marginal cost is
 * ~0, the read being shared with redaction).
 */
const CASEDESK_CASE_ID: CaseIdReaderConfig = { pattern: /^NS-\d{4}-\d{4}$/, region: { x: 0.1, y: 0, width: 0.68, height: 0.2 } };
const CLIENT_OCR_SCALE = 2;
const TESSDATA = new URL("../../../apps/web/public/tesseract", import.meta.url);

/** Nearest-neighbour upscale (what the client's canvas drawImage approximates), so small header text is legible to OCR. */
function upscale(image: RgbaImage, scale: number): RgbaImage {
  const out = createRgba(Math.round(image.width * scale), Math.round(image.height * scale));
  for (let y = 0; y < out.height; y += 1)
    for (let x = 0; x < out.width; x += 1) {
      const si = (Math.floor(y / scale) * image.width + Math.floor(x / scale)) * 4;
      const di = (y * out.width + x) * 4;
      out.data[di] = image.data[si] ?? 0;
      out.data[di + 1] = image.data[si + 1] ?? 0;
      out.data[di + 2] = image.data[si + 2] ?? 0;
      out.data[di + 3] = 255;
    }
  return out;
}

async function ocrRegion(worker: Worker, image: RgbaImage, region: Rect): Promise<OcrWord[]> {
  const crop = cropRgba(image, region);
  const { data } = await worker.recognize(Buffer.from(encodePng(upscale(crop, CLIENT_OCR_SCALE))), {}, { blocks: true });
  const words: OcrWord[] = [];
  let line = 0;
  for (const block of data.blocks ?? [])
    for (const paragraph of block.paragraphs)
      for (const l of paragraph.lines) {
        for (const w of l.words)
          words.push({
            text: w.text,
            line,
            ...(typeof w.confidence === "number" && { confidence: w.confidence / 100 }),
            bbox: {
              x: region.x + w.bbox.x0 / CLIENT_OCR_SCALE,
              y: region.y + w.bbox.y0 / CLIENT_OCR_SCALE,
              width: (w.bbox.x1 - w.bbox.x0) / CLIENT_OCR_SCALE,
              height: (w.bbox.y1 - w.bbox.y0) / CLIENT_OCR_SCALE,
            },
          });
        line += 1;
      }
  return words;
}

type ClientCaseIdStats = { reads: number; matches: number; distinct: string[]; ocrMs: number[] };
type ClientCaseIdPrePass = ClientCaseIdStats & { frames: ReplayFrame[] };

/**
 * Reads the client case id for every frame before the timed replay (so OCR never perturbs the
 * real-time pacing), carrying it forward. A dedicated OCR of the change region runs only on frames
 * whose change touches the header band (case switches, list screens) — the browser's redaction OCR
 * reads that same region; other frames cannot change the id and keep the last one.
 */
async function precomputeClientCaseIds(input: readonly ReplayFrame[]): Promise<ClientCaseIdPrePass> {
  const worker = await createWorker("eng", OEM.LSTM_ONLY, { langPath: TESSDATA.pathname, gzip: true, cacheMethod: "none", logger: () => undefined });
  try {
    const detector = createChangeDetector();
    const tracker = createCaseIdTracker(CASEDESK_CASE_ID);
    const out: ReplayFrame[] = [];
    const distinct = new Set<string>();
    const ocrMs: number[] = [];
    let reads = 0;
    let matches = 0;
    for (const frame of input) {
      const image = frame.load();
      const change = detector.push(image);
      const size = { width: image.width, height: image.height };
      const headerPx = clampRect({ x: CASEDESK_CASE_ID.region.x * size.width, y: CASEDESK_CASE_ID.region.y * size.height, width: CASEDESK_CASE_ID.region.width * size.width, height: CASEDESK_CASE_ID.region.height * size.height }, size.width, size.height);
      const touchesHeader = change.changed && headerPx !== null && (change.bbox === null || rectsIntersect(change.bbox, headerPx));
      if (touchesHeader && headerPx !== null) {
        // The region the browser's redaction OCR reads: the change bbox (a tight header crop reads the small id far worse: 9% vs 98% correct).
        const region = (change.bbox === null ? null : clampRect(change.bbox, size.width, size.height)) ?? { x: 0, y: 0, width: size.width, height: size.height };
        const t0 = performance.now();
        const words = await ocrRegion(worker, image, region);
        ocrMs.push(performance.now() - t0);
        reads += 1;
        if (readCaseId(words, size, CASEDESK_CASE_ID) !== null) matches += 1;
        tracker.read(words, size, region);
      }
      const current = tracker.current();
      if (current !== null) distinct.add(current.value);
      out.push({ ...frame, clientCaseId: current });
    }
    return { frames: out, reads, matches, distinct: [...distinct], ocrMs };
  } finally {
    await worker.terminate();
  }
}
const clientCaseIdBox: { stats: ClientCaseIdStats | null } = { stats: null };

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
  let replayFrames = frames;
  if (!args["no-client-caseid"]) {
    const prepass = await precomputeClientCaseIds(frames);
    replayFrames = prepass.frames;
    clientCaseIdBox.stats = { reads: prepass.reads, matches: prepass.matches, distinct: prepass.distinct, ocrMs: prepass.ocrMs };
  }
  return replaySession({ domain, profile, sessionEpoch, frames: replayFrames, extract, clock: createRealClock(start), maxInFlight });
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
if (clientCaseIdBox.stats !== null)
  console.info(
    `client case-id OCR (change region touching the header band, team P2 decision): ${clientCaseIdBox.stats.reads} reads, ${clientCaseIdBox.stats.matches} matched; ids ${JSON.stringify(clientCaseIdBox.stats.distinct)}; OCR p50 ${percentile(clientCaseIdBox.stats.ocrMs, 50) ?? "n/a"} ms, p95 ${percentile(clientCaseIdBox.stats.ocrMs, 95) ?? "n/a"} ms (dedicated Node OCR; shared with redaction in-product)`,
  );
for (const error of result.errors) console.error(`error: ${error}`);

if (args.out !== undefined) {
  const body = {
    mode: args.fake ? "fake" : "live",
    seed: args.fake ? seed : null,
    maxInFlight,
    fixture: resolve(fixtureDir),
    report,
    pipeline: { frames: result.frames, queue: q, dropped: dropCounts, concepts: result.concepts, conceptNames, errors: result.errors },
    usage: args.fake ? null : usage,
    clientCaseId:
      clientCaseIdBox.stats === null
        ? null
        : {
            headerReads: clientCaseIdBox.stats.reads,
            matched: clientCaseIdBox.stats.matches,
            distinctIds: clientCaseIdBox.stats.distinct,
            ocrMs: { n: clientCaseIdBox.stats.ocrMs.length, p50: percentile(clientCaseIdBox.stats.ocrMs, 50), p95: percentile(clientCaseIdBox.stats.ocrMs, 95), samples: clientCaseIdBox.stats.ocrMs.map((m) => Math.round(m)) },
          },
    reads: args.fake ? null : reads,
  };
  writeFileSync(args.out, `${JSON.stringify(body, null, 2)}\n`);
  console.info(`\nJSON report: ${resolve(args.out)}`);
}
process.exit(report.pass ? 0 : 1);
