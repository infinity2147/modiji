/**
 * Frame change detector (plan §7.1). Isomorphic and pure: each frame is reduced to a 64×36
 * grayscale thumbnail (area average) and a 64-bit dHash; consecutive frames are compared by
 *
 * - `score`: mean absolute thumbnail difference (0–255);
 * - `hamming`: dHash Hamming distance (0–64);
 * - `maxCellDiff`: the largest single-cell difference.
 *
 * The per-cell test is what catches small edits: on a 1920×1080 screen a cell is 30×30 px, so a
 * changed dropdown value moves a handful of cells by tens of grey levels while the mean over all
 * 2,304 cells barely moves and the 9×8 dHash usually not at all. The mean and hash tests catch
 * diffuse changes (fades, theme switches) that no single cell crosses. The changed-region bbox is
 * the hull of the cells over the cell threshold, mapped back to full resolution and padded.
 */
import { clampRect, type Rect, type RgbaImage, assertRgba, padRect } from "./image";

export const GRID_WIDTH = 64;
export const GRID_HEIGHT = 36;

export type ChangeDetectorConfig = {
  /** A cell whose mean grey level moved by at least this much (0–255) is changed. */
  cellThreshold: number;
  /** Mean absolute thumbnail difference (0–255) at or above which the frame is changed. */
  scoreThreshold: number;
  /** dHash Hamming distance at or above which the frame is changed. */
  hammingThreshold: number;
  /** Padding added around the changed region, in full-resolution pixels. */
  padding: number;
};

/**
 * Defaults: a text caret (≈1×16 px) moves a 30×30 cell by about 4 grey levels, so 6 ignores a
 * blinking caret while a changed word (dozens of dark pixels) clears it. Tune on recorded fixtures.
 */
export const DEFAULT_CHANGE_CONFIG: ChangeDetectorConfig = { cellThreshold: 6, scoreThreshold: 2, hammingThreshold: 6, padding: 16 };

export type Thumbnail = {
  /** 64×36 grey levels, row-major. */
  gray: Float32Array;
  /** 64-bit difference hash over a 9×8 reduction of `gray`. */
  hash: bigint;
  width: number;
  height: number;
};

export type ChangeReason = "first" | "resized" | "cells" | "score" | "hash" | "none";

export type ChangeResult = {
  changed: boolean;
  reason: ChangeReason;
  /** Mean absolute thumbnail difference, 0–255 (0 for the first frame). */
  score: number;
  /** dHash Hamming distance, 0–64 (0 for the first frame). */
  hamming: number;
  maxCellDiff: number;
  /** Changed region in full-resolution pixels; the whole frame for first/resized/diffuse changes; null when unchanged. */
  bbox: Rect | null;
};

/** 64×36 area-average grayscale thumbnail plus dHash. Luma uses Rec. 601 weights. */
export function thumbnail(image: RgbaImage): Thumbnail {
  assertRgba(image);
  const { data, width, height } = image;
  const sums = new Float64Array(GRID_WIDTH * GRID_HEIGHT);
  const counts = new Uint32Array(GRID_WIDTH * GRID_HEIGHT);
  const cellX = new Uint16Array(width);
  for (let x = 0; x < width; x += 1) cellX[x] = Math.floor((x * GRID_WIDTH) / width);
  for (let y = 0; y < height; y += 1) {
    const rowCell = Math.floor((y * GRID_HEIGHT) / height) * GRID_WIDTH;
    let i = y * width * 4;
    for (let x = 0; x < width; x += 1, i += 4) {
      const cell = rowCell + (cellX[x] ?? 0);
      sums[cell] = (sums[cell] ?? 0) + 0.299 * (data[i] ?? 0) + 0.587 * (data[i + 1] ?? 0) + 0.114 * (data[i + 2] ?? 0);
      counts[cell] = (counts[cell] ?? 0) + 1;
    }
  }
  const gray = new Float32Array(GRID_WIDTH * GRID_HEIGHT);
  // A frame narrower than 64 px or shorter than 36 px leaves some cells empty; they read as black.
  for (let c = 0; c < gray.length; c += 1) gray[c] = (counts[c] ?? 0) > 0 ? (sums[c] ?? 0) / (counts[c] ?? 1) : 0;
  return { gray, hash: dHash(gray), width, height };
}

/**
 * Minimum brightness step (grey levels) for a dHash bit. Plain dHash sets a bit when left > right;
 * on flat UI backgrounds the two are equal up to noise, so bits would flip at random. Requiring a
 * real step keeps flat regions at a stable 0.
 */
const DHASH_MARGIN = 1;

/** dHash: reduce to 9×8 by area average, then one bit per horizontally adjacent pair (left brighter than right by the margin). */
function dHash(gray: Float32Array): bigint {
  const reduced = new Float64Array(9 * 8);
  for (let y = 0; y < GRID_HEIGHT; y += 1) {
    for (let x = 0; x < GRID_WIDTH; x += 1) {
      const cell = Math.floor((y * 8) / GRID_HEIGHT) * 9 + Math.floor((x * 9) / GRID_WIDTH);
      reduced[cell] = (reduced[cell] ?? 0) + (gray[y * GRID_WIDTH + x] ?? 0);
    }
  }
  // Each reduced cell covers 7–8 × 4–5 grid cells; normalise so unequal footprints don't bias the bits.
  const area = new Float64Array(9 * 8);
  for (let y = 0; y < GRID_HEIGHT; y += 1)
    for (let x = 0; x < GRID_WIDTH; x += 1) {
      const cell = Math.floor((y * 8) / GRID_HEIGHT) * 9 + Math.floor((x * 9) / GRID_WIDTH);
      area[cell] = (area[cell] ?? 0) + 1;
    }
  let hash = 0n;
  for (let y = 0; y < 8; y += 1)
    for (let x = 0; x < 8; x += 1) {
      const left = (reduced[y * 9 + x] ?? 0) / (area[y * 9 + x] ?? 1);
      const right = (reduced[y * 9 + x + 1] ?? 0) / (area[y * 9 + x + 1] ?? 1);
      hash = (hash << 1n) | (left - right > DHASH_MARGIN ? 1n : 0n);
    }
  return hash;
}

export function hammingDistance(a: bigint, b: bigint): number {
  let x = a ^ b;
  let count = 0;
  while (x > 0n) {
    count += Number(x & 1n);
    x >>= 1n;
  }
  return count;
}

/** Compares two thumbnails of the current frame size. `previous` null (or a different size) is a full change. */
export function compareThumbnails(
  previous: Thumbnail | null,
  next: Thumbnail,
  config: ChangeDetectorConfig = DEFAULT_CHANGE_CONFIG,
): ChangeResult {
  const full: Rect = { x: 0, y: 0, width: next.width, height: next.height };
  if (previous === null) return { changed: true, reason: "first", score: 0, hamming: 0, maxCellDiff: 0, bbox: full };
  if (previous.width !== next.width || previous.height !== next.height)
    return { changed: true, reason: "resized", score: 0, hamming: 0, maxCellDiff: 0, bbox: full };

  let total = 0;
  let maxCellDiff = 0;
  let minX = GRID_WIDTH;
  let minY = GRID_HEIGHT;
  let maxX = -1;
  let maxY = -1;
  for (let y = 0; y < GRID_HEIGHT; y += 1)
    for (let x = 0; x < GRID_WIDTH; x += 1) {
      const c = y * GRID_WIDTH + x;
      const diff = Math.abs((next.gray[c] ?? 0) - (previous.gray[c] ?? 0));
      total += diff;
      if (diff > maxCellDiff) maxCellDiff = diff;
      if (diff >= config.cellThreshold) {
        minX = Math.min(minX, x);
        minY = Math.min(minY, y);
        maxX = Math.max(maxX, x);
        maxY = Math.max(maxY, y);
      }
    }
  const score = total / (GRID_WIDTH * GRID_HEIGHT);
  const hamming = hammingDistance(previous.hash, next.hash);
  const base = { score, hamming, maxCellDiff };

  if (maxX >= 0) {
    // Cell (cx, cy) covers source pixels [floor(cx·W/64), floor((cx+1)·W/64)) — the thumbnail's own mapping, inverted.
    const x0 = Math.floor((minX * next.width) / GRID_WIDTH);
    const y0 = Math.floor((minY * next.height) / GRID_HEIGHT);
    const x1 = Math.ceil(((maxX + 1) * next.width) / GRID_WIDTH);
    const y1 = Math.ceil(((maxY + 1) * next.height) / GRID_HEIGHT);
    const bbox = clampRect(padRect({ x: x0, y: y0, width: x1 - x0, height: y1 - y0 }, config.padding), next.width, next.height);
    return { changed: true, reason: "cells", ...base, bbox: bbox ?? full };
  }
  if (score >= config.scoreThreshold) return { changed: true, reason: "score", ...base, bbox: full };
  if (hamming >= config.hammingThreshold) return { changed: true, reason: "hash", ...base, bbox: full };
  return { changed: false, reason: "none", ...base, bbox: null };
}

export type ChangeDetector = {
  /** Compares `image` with the reference frame; a changed frame becomes the new reference. */
  push(image: RgbaImage): ChangeResult;
  /** Forgets the reference frame, so the next push is a full change (e.g. after resuming capture). */
  reset(): void;
};

/**
 * Stateful wrapper over `thumbnail` + `compareThumbnails`. The reference is the last frame reported
 * as changed, not simply the previous frame: an edit spread over several frames (typing one
 * character per frame) accumulates until it crosses a threshold instead of slipping under it frame
 * by frame. Independent pixel noise does not accumulate against a fixed reference.
 */
export function createChangeDetector(config: ChangeDetectorConfig = DEFAULT_CHANGE_CONFIG): ChangeDetector {
  let previous: Thumbnail | null = null;
  return {
    push(image) {
      const next = thumbnail(image);
      const result = compareThumbnails(previous, next, config);
      if (result.changed) previous = next;
      return result;
    },
    reset() {
      previous = null;
    },
  };
}
