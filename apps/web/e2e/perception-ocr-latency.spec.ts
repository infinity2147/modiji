/**
 * Client-side OCR + redaction latency on the recorded fixture, in Chromium (tagged @measure: not in
 * the default e2e run; run after the recorder).
 *
 *   pnpm --filter @vashistha/web exec playwright test --grep @measure
 *
 * The perception package's change detector and redactor (Tesseract.js from /tesseract/, exactly as
 * the capture pipeline uses them) are bundled with esbuild and injected into a page of the running
 * app. Frames are fed in capture order; every frame the detector reports as changed is redacted and
 * timed. Writes docs/evidence/p2/ocr-latency.json.
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { build } from "esbuild";
import { expect, test } from "@playwright/test";
import { kycCases } from "@vashistha/core/domains/kyc";
import { FixtureSchema, percentile } from "../../../packages/perception/src/evaluation";
import { personNames } from "../lib/client/capture/browser";

const FIXTURE_DIR = join(import.meta.dirname, "../../../packages/perception/test/fixtures/casedesk-recorded");
const PERCEPTION_SRC = join(import.meta.dirname, "../../../packages/perception/src");
const OUT = join(import.meta.dirname, "../../../docs/evidence/p2/ocr-latency.json");
/** Changed frames to time (the first is a full-frame read). */
const SAMPLE = 80;

type Timing = { frameSeq: number; ms: number; reason: string; region: number; boxes: number };

test("@measure OCR + PII blur latency per changed frame in Chromium", async ({ page }) => {
  test.setTimeout(30 * 60_000);
  const fixture = FixtureSchema.parse(JSON.parse(readFileSync(join(FIXTURE_DIR, "fixture.json"), "utf8")));
  const bundle = await build({
    stdin: {
      contents: `import { createChangeDetector, createRedactor, createTesseractOcr } from "./index.ts";
        const ocr = createTesseractOcr({ basePath: "/tesseract/" });
        let redactor = null;
        const detector = createChangeDetector();
        window.__ocrBench = {
          init: (names) => { redactor = createRedactor({ ocr: ocr.ocr, names: () => names }); },
          frame: async (b64) => {
            const bitmap = await createImageBitmap(await (await fetch("data:image/png;base64," + b64)).blob());
            const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
            const ctx = canvas.getContext("2d", { willReadFrequently: true });
            ctx.drawImage(bitmap, 0, 0);
            const { data } = ctx.getImageData(0, 0, bitmap.width, bitmap.height);
            const image = { data, width: bitmap.width, height: bitmap.height };
            const change = detector.push(image);
            if (!change.changed) return null;
            const t0 = performance.now();
            const result = await redactor.redact(image, change.bbox);
            return { ms: performance.now() - t0, reason: change.reason, region: result.ocrRegion.width * result.ocrRegion.height, boxes: result.boxes.length };
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

  const timings: Timing[] = [];
  let previousFile = "";
  for (const frame of fixture.frames) {
    if (timings.length >= SAMPLE) break;
    if (frame.file === previousFile) continue; // byte-identical capture: the detector would see no change
    previousFile = frame.file;
    const b64 = readFileSync(join(FIXTURE_DIR, frame.file)).toString("base64");
    const result = await page.evaluate(
      (data) =>
        (window as unknown as { __ocrBench: { frame: (b64: string) => Promise<Omit<Timing, "frameSeq"> | null> } }).__ocrBench.frame(data),
      b64,
    );
    if (result !== null) timings.push({ frameSeq: frame.frameSeq, ...result });
  }
  expect(timings.length).toBeGreaterThan(10);

  const [first, ...rest] = timings;
  const all = timings.map((t) => t.ms);
  const partial = rest.map((t) => t.ms);
  const round = (v: number | null) => (v === null ? null : Math.round(v));
  const report = {
    host: "headless Chromium (Playwright 1.63) on the development machine; single run",
    fixture: "packages/perception/test/fixtures/casedesk-recorded",
    frameSize: "1440×900 at 1× (OCR upscales the read region 2×)",
    changedFramesTimed: timings.length,
    firstFullFrameMs: round(first?.ms ?? null),
    allChangedFrames: { p50: round(percentile(all, 50)), p95: round(percentile(all, 95)), max: round(Math.max(...all)) },
    afterFirstFrame: { p50: round(percentile(partial, 50)), p95: round(percentile(partial, 95)) },
    meanRegionShare: Math.round((timings.reduce((s, t) => s + t.region, 0) / timings.length / (1440 * 900)) * 1000) / 1000,
    timings: timings.map((t) => ({ ...t, ms: Math.round(t.ms) })),
  };
  mkdirSync(join(OUT, ".."), { recursive: true });
  writeFileSync(OUT, `${JSON.stringify(report, null, 2)}\n`);
  console.info(
    `OCR+blur over ${timings.length} changed frames: first (full frame) ${report.firstFullFrameMs} ms; p50 ${report.allChangedFrames.p50} ms, p95 ${report.allChangedFrames.p95} ms, max ${report.allChangedFrames.max} ms; mean region ${(report.meanRegionShare * 100).toFixed(1)}% of the frame`,
  );
});
