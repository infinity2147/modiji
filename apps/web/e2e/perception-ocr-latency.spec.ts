/**
 * Client-side OCR + redaction latency on the recorded fixture, in Chromium (tagged @measure: not in
 * the default e2e run; run after the recorder).
 *
 *   pnpm --filter @vashistha/web exec playwright test --grep @measure
 *
 * The perception package's change detector and redactor (Tesseract.js from /tesseract/, exactly as
 * the capture pipeline uses them) are bundled with esbuild and injected into a page of the running
 * app. Frames are fed in capture order; every frame the detector reports as changed is redacted by
 * one redactor per OCR setting (each with its own Tesseract worker and carried boxes) and timed.
 * PII recall of a setting = share of the reference setting's PII boxes (2× everywhere, the previous
 * client default) that the setting's boxes overlap, per frame. Writes docs/evidence/p2/ocr-latency.json.
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { build } from "esbuild";
import { expect, test } from "./support/accounts";
import { kycCases } from "@vashistha/core/domains/kyc";
import { FixtureSchema, percentile } from "../../../packages/perception/src/evaluation";
import { CLIENT_OCR_SCALE, personNames } from "../lib/client/capture/browser";

const FIXTURE_DIR = join(import.meta.dirname, "../../../packages/perception/test/fixtures/casedesk-recorded");
const PERCEPTION_SRC = join(import.meta.dirname, "../../../packages/perception/src");
const OUT = join(import.meta.dirname, "../../../docs/evidence/p2/ocr-latency.json");
/** Changed frames to time (the first is a full-frame read). */
const SAMPLE = 80;

/** OCR settings compared; `reference` is what PII recall is measured against. */
const SETTINGS = {
  reference: { scale: 2 },
  large15: { scale: 2, largeRegion: { share: 0.25, scale: 1.5 } },
  large1: { scale: 2, largeRegion: { share: 0.25, scale: 1 } },
} as const;
type SettingName = keyof typeof SETTINGS;

type Box = { x: number; y: number; width: number; height: number };
type Result = { ms: number; region: number; boxes: Box[]; kinds: string[] };
type FrameResult = { frameSeq: number; reason: string; results: Record<SettingName, Result> };

const overlaps = (a: Box, b: Box): boolean => a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height;

test("@measure OCR + PII blur latency per changed frame in Chromium", async ({ page }) => {
  test.setTimeout(60 * 60_000);
  const fixture = FixtureSchema.parse(JSON.parse(readFileSync(join(FIXTURE_DIR, "fixture.json"), "utf8")));
  const bundle = await build({
    stdin: {
      contents: `import { createChangeDetector, createRedactor, createTesseractOcr } from "./index.ts";
        const settings = ${JSON.stringify(SETTINGS)};
        const redactors = {};
        const detector = createChangeDetector();
        window.__ocrBench = {
          init: (names) => {
            for (const [name, setting] of Object.entries(settings))
              redactors[name] = createRedactor({ ocr: createTesseractOcr({ basePath: "/tesseract/", ...setting }).ocr, names: () => names });
          },
          frame: async (b64) => {
            const bitmap = await createImageBitmap(await (await fetch("data:image/png;base64," + b64)).blob());
            const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
            const ctx = canvas.getContext("2d", { willReadFrequently: true });
            ctx.drawImage(bitmap, 0, 0);
            const { data } = ctx.getImageData(0, 0, bitmap.width, bitmap.height);
            const image = { data, width: bitmap.width, height: bitmap.height };
            const change = detector.push(image);
            if (!change.changed) return null;
            const results = {};
            for (const [name, redactor] of Object.entries(redactors)) {
              const t0 = performance.now();
              const result = await redactor.redact(image, change.bbox);
              results[name] = {
                ms: performance.now() - t0,
                region: result.ocrRegion.width * result.ocrRegion.height,
                boxes: result.boxes.map((b) => b.box),
                kinds: result.boxes.map((b) => b.kind),
              };
            }
            return { reason: change.reason, results };
          },
        };`,
      resolveDir: PERCEPTION_SRC,
      loader: "ts",
    },
    bundle: true,
    format: "iife",
    platform: "browser",
    write: false,
    logLevel: "silent",
  });
  await page.goto("/sandbox");
  await page.addScriptTag({ content: bundle.outputFiles[0]?.text ?? "" });
  const names = personNames([...kycCases("training"), ...kycCases("practice")]);
  await page.evaluate((n) => (window as unknown as { __ocrBench: { init: (names: string[]) => void } }).__ocrBench.init(n), names);

  const frames: FrameResult[] = [];
  let previousFile = "";
  for (const frame of fixture.frames) {
    if (frames.length >= SAMPLE) break;
    if (frame.file === previousFile) continue; // byte-identical capture: the detector would see no change
    previousFile = frame.file;
    const b64 = readFileSync(join(FIXTURE_DIR, frame.file)).toString("base64");
    const result = await page.evaluate(
      (data) =>
        (window as unknown as { __ocrBench: { frame: (b64: string) => Promise<Omit<FrameResult, "frameSeq"> | null> } }).__ocrBench.frame(data),
      b64,
    );
    if (result !== null) frames.push({ frameSeq: frame.frameSeq, ...result });
  }
  expect(frames.length).toBeGreaterThan(10);

  const round = (v: number | null) => (v === null ? null : Math.round(v));
  const frameArea = 1440 * 900;
  const summarise = (name: SettingName) => {
    const ms = frames.map((f) => f.results[name].ms);
    const after = ms.slice(1);
    const large = frames.filter((f) => f.results[name].region >= 0.25 * frameArea).map((f) => f.results[name].ms);
    // PII recall against the reference: reference boxes this setting's boxes overlap, over all frames.
    let found = 0;
    let total = 0;
    const missedKinds: Record<string, number> = {};
    for (const f of frames) {
      const mine = f.results[name].boxes;
      f.results.reference.boxes.forEach((box, i) => {
        total += 1;
        if (mine.some((b) => overlaps(b, box))) found += 1;
        else {
          const kind = f.results.reference.kinds[i] ?? "unknown";
          missedKinds[kind] = (missedKinds[kind] ?? 0) + 1;
        }
      });
    }
    return {
      setting: SETTINGS[name],
      firstFullFrameMs: round(ms[0] ?? null),
      allChangedFrames: { p50: round(percentile(ms, 50)), p95: round(percentile(ms, 95)), max: round(Math.max(...ms)) },
      afterFirstFrame: { p50: round(percentile(after, 50)), p95: round(percentile(after, 95)) },
      largeRegions: { n: large.length, p50: round(percentile(large, 50)), p95: round(percentile(large, 95)) },
      piiBoxesPerFrame: Math.round((frames.reduce((s, f) => s + f.results[name].boxes.length, 0) / frames.length) * 10) / 10,
      piiRecallVsReference: name === "reference" ? 1 : total === 0 ? null : Math.round((found / total) * 1000) / 1000,
      missedReferenceBoxesByKind: missedKinds,
    };
  };
  const report = {
    host: "headless Chromium (Playwright) on the development machine; single run, settings interleaved per frame",
    fixture: "packages/perception/test/fixtures/casedesk-recorded",
    frameSize: "1440×900 at 1×",
    clientSetting: CLIENT_OCR_SCALE,
    changedFramesTimed: frames.length,
    meanRegionShare: Math.round((frames.reduce((s, f) => s + f.results.reference.region, 0) / frames.length / frameArea) * 1000) / 1000,
    settings: Object.fromEntries((Object.keys(SETTINGS) as SettingName[]).map((name) => [name, summarise(name)])),
    timings: frames.map((f) => ({
      frameSeq: f.frameSeq,
      reason: f.reason,
      region: f.results.reference.region,
      ms: Object.fromEntries(Object.entries(f.results).map(([name, r]) => [name, Math.round(r.ms)])),
      boxes: Object.fromEntries(Object.entries(f.results).map(([name, r]) => [name, r.boxes.length])),
    })),
  };
  mkdirSync(join(OUT, ".."), { recursive: true });
  writeFileSync(OUT, `${JSON.stringify(report, null, 2)}\n`);
  for (const [name, s] of Object.entries(report.settings))
    console.info(
      `${name}: OCR+blur p50 ${s.allChangedFrames.p50} ms, p95 ${s.allChangedFrames.p95} ms (large regions p95 ${s.largeRegions.p95} ms, n=${s.largeRegions.n}); PII recall vs 2× ${s.piiRecallVsReference}`,
    );
});
