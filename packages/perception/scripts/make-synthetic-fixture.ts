/**
 * Writes the tiny synthetic fixture under test/fixtures/synthetic-kyc (see FIXTURES.md): a 24 s
 * CaseDesk-like session over the three KYC training cases, rendered as flat 320×180 frames (one
 * every 500 ms, with ±1 grey-level noise) plus the DOM events that produced them. It exercises the
 * harness only; real fixtures come from the CaseDesk Playwright recorder.
 *
 *   pnpm --filter @vashistha/web exec tsx ../../packages/perception/scripts/make-synthetic-fixture.ts
 */
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { ActionIdSchema, FeatureIdSchema, type ScreenEvent } from "@vashistha/core";
import { KYC_DOMAIN, mulberry32 } from "@vashistha/core/domains/kyc";
import { createRgba, type RgbaImage } from "../src/image";
import type { Fixture } from "../src/evaluation";
import { encodePng } from "../src/png";

const OUT_DIR = join(import.meta.dirname, "../test/fixtures/synthetic-kyc");
const T0 = 1_790_000_000_000;
const WIDTH = 320;
const HEIGHT = 180;
const FRAME_MS = 500;
const FRAMES = 48;

type Step =
  | { at: number; kind: "navigate" }
  | { at: number; kind: "open_case"; caseId: string }
  | { at: number; kind: "field_change"; caseId: string; from: string; to: string }
  | { at: number; kind: "action"; caseId: string; action: string };

/** Every field change is the reviewer's risk rating (the one editable field); actions are committed outcomes. */
const STEPS: Step[] = [
  { at: 300, kind: "navigate" },
  { at: 2100, kind: "open_case", caseId: "NS-2026-0101" },
  { at: 4200, kind: "field_change", caseId: "NS-2026-0101", from: "unrated", to: "high" },
  { at: 6300, kind: "action", caseId: "NS-2026-0101", action: "enhancedReview" },
  // A quick list → next case hop while a request is in flight: exercises coalescing.
  { at: 7000, kind: "navigate" },
  { at: 7600, kind: "open_case", caseId: "NS-2026-0102" },
  { at: 9900, kind: "field_change", caseId: "NS-2026-0102", from: "unrated", to: "medium" },
  { at: 11800, kind: "field_change", caseId: "NS-2026-0102", from: "medium", to: "low" },
  { at: 13600, kind: "action", caseId: "NS-2026-0102", action: "approve" },
  { at: 15400, kind: "open_case", caseId: "NS-2026-0103" },
  { at: 17300, kind: "field_change", caseId: "NS-2026-0103", from: "unrated", to: "high" },
  { at: 19200, kind: "action", caseId: "NS-2026-0103", action: "escalateCompliance" },
  { at: 21000, kind: "navigate" },
];


function domEvent(step: Step, index: number): ScreenEvent {
  const event: ScreenEvent = {
    id: `dom-${index + 1}`,
    frameSeq: index + 1,
    captureTime: T0 + step.at,
    sessionEpoch: 0,
    kind: step.kind,
    confidence: 1,
    source: "dom",
    critical: step.kind === "field_change" && KYC_DOMAIN.criticalFields.includes(FeatureIdSchema.parse("riskRating")),
  };
  if (step.kind !== "navigate") event.caseId = step.caseId;
  if (step.kind === "field_change") Object.assign(event, { field: FeatureIdSchema.parse("riskRating"), from: step.from, to: step.to });
  if (step.kind === "action") event.action = ActionIdSchema.parse(step.action);
  return event;
}

type Screen = { caseId: string | null; rating: string; action: string | null };

const CASE_SHADE: Record<string, number> = { "NS-2026-0101": 70, "NS-2026-0102": 120, "NS-2026-0103": 170 };
const RATING_SHADE: Record<string, number> = { unrated: 220, low: 160, medium: 110, high: 40 };
const ACTION_SHADE: Record<string, number> = { enhancedReview: 60, approve: 130, escalateCompliance: 200 };

function fill(img: RgbaImage, x: number, y: number, w: number, h: number, shade: number): void {
  for (let yy = y; yy < y + h; yy += 1)
    for (let xx = x; xx < x + w; xx += 1) img.data.set([shade, shade, shade, 255], (yy * img.width + xx) * 4);
}

function render(screen: Screen, rng: () => number): RgbaImage {
  const img = createRgba(WIDTH, HEIGHT);
  fill(img, 0, 0, WIDTH, HEIGHT, 240);
  fill(img, 0, 0, WIDTH, 20, 30);
  if (screen.caseId === null) for (let row = 0; row < 5; row += 1) fill(img, 10, 30 + row * 28, 300, 20, 200);
  else {
    fill(img, 10, 30, 140, 130, CASE_SHADE[screen.caseId] ?? 90);
    fill(img, 170, 30, 60, 20, RATING_SHADE[screen.rating] ?? 0);
    if (screen.action !== null) fill(img, 170, 60, 140, 20, ACTION_SHADE[screen.action] ?? 0);
  }
  for (let i = 0; i < img.data.length; i += 4) {
    const delta = Math.floor(rng() * 3) - 1;
    for (let c = 0; c < 3; c += 1) img.data[i + c] = (img.data[i + c] ?? 0) + delta;
  }
  return img;
}

function screenAt(t: number): Screen {
  const screen: Screen = { caseId: null, rating: "unrated", action: null };
  for (const step of STEPS) {
    if (step.at > t) break;
    if (step.kind === "navigate") Object.assign(screen, { caseId: null, rating: "unrated", action: null });
    if (step.kind === "open_case") Object.assign(screen, { caseId: step.caseId, rating: "unrated", action: null });
    if (step.kind === "field_change") screen.rating = step.to;
    if (step.kind === "action") screen.action = step.action;
  }
  return screen;
}

rmSync(OUT_DIR, { recursive: true, force: true });
mkdirSync(join(OUT_DIR, "frames"), { recursive: true });
const rng = mulberry32(20261004);
const frames: Fixture["frames"] = [];
for (let i = 0; i < FRAMES; i += 1) {
  const at = 250 + i * FRAME_MS;
  const file = `frames/${String(i + 1).padStart(6, "0")}.png`;
  writeFileSync(join(OUT_DIR, file), encodePng(render(screenAt(at), rng)));
  frames.push({ frameSeq: i + 1, captureTime: T0 + at, file });
}
const fixture: Fixture = { version: 1, domainId: KYC_DOMAIN.id, sessionEpoch: 0, frames, domEvents: STEPS.map(domEvent) };
writeFileSync(join(OUT_DIR, "fixture.json"), `${JSON.stringify(fixture, null, 2)}\n`);
console.info(`wrote ${frames.length} frames and ${fixture.domEvents.length} DOM events to ${OUT_DIR}`);
