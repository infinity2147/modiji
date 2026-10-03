import { describe, expect, it } from "vitest";
import {
  compareThumbnails,
  createChangeDetector,
  DEFAULT_CHANGE_CONFIG,
  hammingDistance,
  thumbnail,
} from "../src/change-detector";
import { createRgba, type RgbaImage } from "../src/image";
import { mulberry32 } from "@vashistha/core/domains/kyc";

const W = 1280;
const H = 720;

function screen(shade = 240): RgbaImage {
  const img = createRgba(W, H);
  for (let i = 0; i < img.data.length; i += 4) img.data.set([shade, shade, shade, 255], i);
  // Some fixed UI structure, so the dHash has real edges to encode.
  rect(img, 0, 0, W, 60, 30);
  rect(img, 0, 60, 300, H - 60, 210);
  return img;
}

function rect(img: RgbaImage, x: number, y: number, w: number, h: number, shade: number): void {
  for (let yy = y; yy < y + h; yy += 1)
    for (let xx = x; xx < x + w; xx += 1) img.data.set([shade, shade, shade, 255], (yy * img.width + xx) * 4);
}

function noisy(img: RgbaImage, seed: number, amplitude: number): RgbaImage {
  const rng = mulberry32(seed);
  const out = createRgba(img.width, img.height);
  out.data.set(img.data);
  for (let i = 0; i < out.data.length; i += 4)
    for (let c = 0; c < 3; c += 1) out.data[i + c] = (out.data[i + c] ?? 0) + Math.round((rng() * 2 - 1) * amplitude);
  return out;
}

describe("change detector", () => {
  it("reports the first frame as a full change", () => {
    const result = createChangeDetector().push(screen());
    expect(result).toMatchObject({ changed: true, reason: "first", bbox: { x: 0, y: 0, width: W, height: H } });
  });

  it("identical frames are unchanged", () => {
    const detector = createChangeDetector();
    detector.push(screen());
    expect(detector.push(screen())).toEqual({ changed: false, reason: "none", score: 0, hamming: 0, maxCellDiff: 0, bbox: null });
  });

  it("a drawn rectangle is a change whose bbox covers it, in full-resolution pixels", () => {
    const detector = createChangeDetector();
    detector.push(screen());
    const next = screen();
    rect(next, 700, 300, 120, 24, 20); // a dark value appearing in a form field
    const result = detector.push(next);
    expect(result.changed).toBe(true);
    expect(result.reason).toBe("cells");
    const bbox = result.bbox;
    if (bbox === null) throw new Error("expected a bbox");
    // Contains the rectangle…
    expect(bbox.x).toBeLessThanOrEqual(700);
    expect(bbox.y).toBeLessThanOrEqual(300);
    expect(bbox.x + bbox.width).toBeGreaterThanOrEqual(820);
    expect(bbox.y + bbox.height).toBeGreaterThanOrEqual(324);
    // …and stays local: at most one 20×20 grid cell plus padding beyond it on each side.
    const slack = W / 64 + DEFAULT_CHANGE_CONFIG.padding;
    expect(bbox.x).toBeGreaterThanOrEqual(700 - slack);
    expect(bbox.y).toBeGreaterThanOrEqual(300 - slack);
    expect(bbox.x + bbox.width).toBeLessThanOrEqual(820 + slack);
    expect(bbox.y + bbox.height).toBeLessThanOrEqual(324 + slack);
    // A small edit barely moves the global mean: the cell test is what caught it.
    expect(result.score).toBeLessThan(DEFAULT_CHANGE_CONFIG.scoreThreshold);
  });

  it("bbox is clamped to the frame at the edges", () => {
    const detector = createChangeDetector();
    detector.push(screen());
    const next = screen();
    rect(next, W - 30, H - 20, 30, 20, 0);
    const bbox = detector.push(next).bbox;
    expect(bbox).not.toBeNull();
    expect((bbox?.x ?? 0) + (bbox?.width ?? 0)).toBe(W);
    expect((bbox?.y ?? 0) + (bbox?.height ?? 0)).toBe(H);
  });

  it("dHash and the diff are stable under tiny pixel noise", () => {
    const base = thumbnail(screen());
    for (const seed of [1, 2, 3, 4, 5]) {
      const other = thumbnail(noisy(screen(), seed, 2));
      expect(hammingDistance(base.hash, other.hash)).toBe(0);
      expect(compareThumbnails(base, other).changed).toBe(false);
    }
  });

  it("a diffuse change no cell crosses is caught by the mean score", () => {
    const detector = createChangeDetector();
    detector.push(screen(240));
    const result = detector.push(screen(236)); // whole background 4 levels darker
    expect(result).toMatchObject({ changed: true, reason: "score", bbox: { x: 0, y: 0, width: W, height: H } });
  });

  it("an edit spread over several frames accumulates against the last changed frame", () => {
    const detector = createChangeDetector({ ...DEFAULT_CHANGE_CONFIG, cellThreshold: 25 });
    detector.push(screen());
    // Text typed into one 20×20 grid cell, 5 px per frame: each step moves the cell by 10 grey levels.
    const steps = [1, 2, 3].map((i) => {
      const img = screen();
      rect(img, 600, 300, 5 * i, 20, 200);
      return img;
    });
    expect(steps.map((img) => detector.push(img).changed)).toEqual([false, false, true]);
  });

  it("a resized frame is a full change", () => {
    const detector = createChangeDetector();
    detector.push(screen());
    expect(detector.push(createRgba(640, 360)).reason).toBe("resized");
  });

  it("rejects a buffer that does not match its size", () => {
    expect(() => thumbnail({ data: new Uint8ClampedArray(10), width: 4, height: 4 })).toThrow(RangeError);
  });
});
