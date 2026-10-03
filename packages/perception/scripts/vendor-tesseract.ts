/**
 * Vendors everything `createTesseractOcr({ basePath })` loads, so the browser fetches OCR code and
 * model from our origin instead of a third-party CDN at demo time:
 *
 * - `worker.min.js` from tesseract.js/dist;
 * - the three LSTM-only cores (`tesseract-core{,-simd,-relaxedsimd}-lstm.wasm.js`, wasm embedded)
 *   from tesseract.js-core — the worker picks one by CPU feature detection;
 * - `eng.traineddata.gz`: the tessdata_fast English model, downloaded from the official
 *   tesseract-ocr/tessdata_fast repository at a pinned tag, checked against a pinned SHA-256 and
 *   gzipped here (the worker is configured with `gzip: true`).
 *
 *   pnpm --filter @vashistha/web exec tsx ../../packages/perception/scripts/vendor-tesseract.ts <targetDir>
 *
 * e.g. target `apps/web/public/tesseract` with `basePath: "/tesseract/"`. Needs network once.
 */
import { createHash } from "node:crypto";
import { copyFileSync, mkdirSync, statSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import { gzipSync } from "node:zlib";

const TRAINEDDATA_URL = "https://raw.githubusercontent.com/tesseract-ocr/tessdata_fast/4.1.0/eng.traineddata";
const TRAINEDDATA_SHA256 = "7d4322bd2a7749724879683fc3912cb542f19906c83bcc1a52132556427170b2";
const CORES = ["tesseract-core-lstm.wasm.js", "tesseract-core-simd-lstm.wasm.js", "tesseract-core-relaxedsimd-lstm.wasm.js"];

const target = process.argv[2];
if (target === undefined) {
  console.error("usage: vendor-tesseract <targetDir>");
  process.exit(2);
}
const out = resolve(target);
mkdirSync(out, { recursive: true });

const require = createRequire(import.meta.url);
const tesseractDir = dirname(require.resolve("tesseract.js/package.json"));
const coreDir = dirname(createRequire(join(tesseractDir, "package.json")).resolve("tesseract.js-core/package.json"));

copyFileSync(join(tesseractDir, "dist/worker.min.js"), join(out, "worker.min.js"));
for (const core of CORES) copyFileSync(join(coreDir, core), join(out, core));

const response = await fetch(TRAINEDDATA_URL);
if (!response.ok) throw new Error(`download failed: HTTP ${response.status} for ${TRAINEDDATA_URL}`);
const model = Buffer.from(await response.arrayBuffer());
const digest = createHash("sha256").update(model).digest("hex");
if (digest !== TRAINEDDATA_SHA256) throw new Error(`eng.traineddata SHA-256 mismatch: got ${digest}, expected ${TRAINEDDATA_SHA256}`);
writeFileSync(join(out, "eng.traineddata.gz"), gzipSync(model, { level: 9 }));

for (const file of ["worker.min.js", ...CORES, "eng.traineddata.gz"])
  console.info(`${file.padEnd(42)} ${(statSync(join(out, file)).size / 1024).toFixed(0).padStart(6)} KiB`);
console.info(`vendored into ${out}`);
