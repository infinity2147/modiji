/**
 * Cost of one capture tick (grab + change detection) in headless Chromium, to justify the 250 ms tick
 * (team P2 decision): `pnpm --filter @vashistha/web exec tsx scripts/measure-tick-cost.ts`.
 * Writes docs/evidence/p2/tick-250ms-cost.json.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { build } from "esbuild";
import { chromium } from "@playwright/test";
const ROOT = "/home/24b4530/modiji/packages/perception/test/fixtures/casedesk-recorded";
const out = await build({ entryPoints: ["/home/24b4530/modiji/packages/perception/src/change-detector.ts"], bundle: true, format: "iife", globalName: "CD", write: false });
const code = out.outputFiles[0]!.text;
const files = ["000003","000010","000016","000020","000005","000012"].map((f) => `data:image/png;base64,${readFileSync(`${ROOT}/frames/${f}.png`).toString("base64")}`);
const browser = await chromium.launch();
const page = await browser.newPage();
await page.setContent("<html></html>");
await page.addScriptTag({ content: `window.__name = (f) => f;\n${code}` }); // tsx wraps functions with __name; the page has no such helper
const result = await page.evaluate(async (urls: string[]) => {
  const bitmaps = await Promise.all(urls.map(async (u) => createImageBitmap(await (await fetch(u)).blob())));
  const w = bitmaps[0]!.width, h = bitmaps[0]!.height;
  const canvas = new OffscreenCanvas(w, h); const ctx = canvas.getContext("2d", { willReadFrequently: true })!;
  const det = (globalThis as unknown as { CD: { createChangeDetector(): { push(image: { data: Uint8ClampedArray; width: number; height: number }): unknown } } }).CD.createChangeDetector();
  const grab: number[] = [], detect: number[] = [], total: number[] = [];
  for (let r = 0; r < 60; r++) for (const b of bitmaps) {
    const t0 = performance.now(); ctx.drawImage(b, 0, 0, w, h); const { data } = ctx.getImageData(0, 0, w, h); const t1 = performance.now();
    det.push({ data, width: w, height: h }); const t2 = performance.now();
    grab.push(t1 - t0); detect.push(t2 - t1); total.push(t2 - t0);
  }
  const p = (xs: number[], q: number) => [...xs].sort((a, b) => a - b)[Math.min(xs.length - 1, Math.ceil(q / 100 * xs.length) - 1)]!;
  const s = (xs: number[]) => ({ p50: +p(xs, 50).toFixed(2), p95: +p(xs, 95).toFixed(2), max: +Math.max(...xs).toFixed(2) });
  return { frame: `${w}x${h}`, n: total.length, grabMs: s(grab), detectMs: s(detect), grabPlusDetectMs: s(total) };
}, files);
await browser.close();
const body = { host: "headless Chromium (Playwright), dev machine, OffscreenCanvas drawImage+getImageData (the grabber's path; no live video decode) then the change detector", tickMs: 250, ...result, shareOfTickP95: +(result.grabPlusDetectMs.p95 / 250).toFixed(3) };
console.info(JSON.stringify(body, null, 2));
writeFileSync("/home/24b4530/modiji/docs/evidence/p2/tick-250ms-cost.json", JSON.stringify(body, null, 2) + "\n");
