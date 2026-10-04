/**
 * Live-product frame→event latency estimate (P2): the replay measures capture → events applied for
 * the server side (ordered queue wait + extraction); the live product adds, before the frame reaches
 * the server, the client's OCR + PII blur (measured in Chromium by `e2e/perception-ocr-latency.spec.ts`)
 * plus PNG encoding and the upload (not measured here: passed as an assumption, default 150 ms).
 *
 *   pnpm --filter @vashistha/web exec tsx ../../packages/perception/scripts/e2e-latency.ts \
 *     ../../docs/evidence/p2/eval-live-4.json ../../docs/evidence/p2/ocr-latency.json [--setting large15] [--upload-ms 150] [--out f.json]
 *
 * Two estimates: (1) an upper bound, the sum of the parts' p95s; (2) a Monte Carlo p95 pairing every
 * replay sample with every OCR sample of the client setting (independent draws, seed-free: all pairs).
 * Neither models the second-order effect that OCR time also delays when the next frame is captured.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { parseArgs } from "node:util";
import { z } from "zod";
import { percentile } from "../src/evaluation";

const { values: args, positionals } = parseArgs({
  allowPositionals: true,
  options: { setting: { type: "string", default: "large15" }, "upload-ms": { type: "string", default: "150" }, out: { type: "string" } },
});
const [evalPath, ocrPath] = positionals;
if (evalPath === undefined || ocrPath === undefined) throw new Error("usage: e2e-latency <eval-live.json> <ocr-latency.json> [--setting name] [--upload-ms n]");
const uploadMs = Number(args["upload-ms"]);

const Eval = z.object({ pipeline: z.object({ queue: z.object({ frameToApplyMs: z.array(z.number()) }) }) });
const Ocr = z.object({ timings: z.array(z.object({ ms: z.record(z.string(), z.number()) })) });
const server = Eval.parse(JSON.parse(readFileSync(evalPath, "utf8"))).pipeline.queue.frameToApplyMs;
const ocr = Ocr.parse(JSON.parse(readFileSync(ocrPath, "utf8"))).timings.flatMap((t) => {
  const ms = t.ms[args.setting];
  return ms === undefined ? [] : [ms];
});
if (ocr.length === 0) throw new Error(`no OCR timings for setting ${args.setting}`);

const pairs: number[] = [];
for (const s of server) for (const o of ocr) pairs.push(s + o + uploadMs);
const p = (xs: readonly number[], q: number): number => Math.round(percentile(xs, q) ?? Number.NaN);
const result = {
  setting: args.setting,
  uploadAndEncodeMsAssumed: uploadMs,
  server: { n: server.length, p50: p(server, 50), p95: p(server, 95) },
  clientOcr: { n: ocr.length, p50: p(ocr, 50), p95: p(ocr, 95) },
  sumOfP95s: p(server, 95) + p(ocr, 95) + uploadMs,
  monteCarlo: { pairs: pairs.length, p50: p(pairs, 50), p95: p(pairs, 95) },
};
console.info(JSON.stringify(result, null, 2));
if (args.out !== undefined) writeFileSync(args.out, `${JSON.stringify(result, null, 2)}\n`);
