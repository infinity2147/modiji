/**
 * Client-side case-id reading (team P2 decision, 2026-10-04).
 *
 * The small grey case id in the CaseDesk detail-panel header (`font-mono text-xs`, measured
 * NS-####-#### at ~12 px) is the one value Haiku reads worst: on the live fixture 16 of 17 false
 * criticals were events attributed to a misread id ("NS-2626-…" for "NS-2026-…"). Tesseract already
 * runs in the browser for the PII pass, so the client reads the id on-device and sends it as trusted
 * metadata; the server uses it as the authoritative caseId and never overrides it with the model's
 * read. The reader is pure (OCR words in, id out) so it is unit-testable and so the eval harness can
 * drive it with a Node OCR of the same frames.
 *
 * Isolating the open case's id from the queue: a case switch changes the detail panel AND the
 * selected row in the queue list, so the OCR pass over the changed region sees every id on screen
 * (the open case's header id plus all the queue rows). The reader therefore keeps only matches whose
 * word box falls inside the declared header region (the detail column's top band); the queue column
 * and the review column are outside it. See `apps/web/lib/client/capture/browser.ts` for CaseDesk's
 * region and pattern, measured from the recorded fixture (header id at x≈305, y≈67; queue ids at
 * x≈17; review ids at x≈1150, on a 1440×900 screen).
 *
 * Browser-safe: no DOM, no node: imports.
 */
import type { Rect } from "./image";
import type { OcrWord } from "./privacy";

/** A case id read on the client, with the OCR confidence of the word it came from (0–1). */
export type ClientCaseId = { value: string; confidence: number };

/** Header region as fractions of the frame (0–1), so it is independent of the capture resolution. */
export type FractionalRect = { x: number; y: number; width: number; height: number };

export type CaseIdReaderConfig = {
  /** Anchored pattern the normalised id token must match (CaseDesk: `/^NS-\d{4}-\d{4}$/`). */
  pattern: RegExp;
  /** The header band (detail-panel top), as fractions of the frame. */
  region: FractionalRect;
  /** A word under this OCR confidence (0–1) is treated as no match, so the model id is used instead. Default 0.5. */
  minConfidence?: number;
  /** Normalises an OCR token before matching; default removes whitespace. */
  normalize?: (raw: string) => string;
};

const DEFAULT_MIN_CONFIDENCE = 0.5;
const stripSpace = (raw: string): string => raw.replace(/\s+/g, "");

/** Pixel rect of a fractional region on a frame of `size`. */
function regionPixels(region: FractionalRect, size: { width: number; height: number }): Rect {
  return { x: region.x * size.width, y: region.y * size.height, width: region.width * size.width, height: region.height * size.height };
}

/** Whether a word's box centre lies inside `rect`. */
function centreInside(box: Rect, rect: Rect): boolean {
  const cx = box.x + box.width / 2;
  const cy = box.y + box.height / 2;
  return cx >= rect.x && cx <= rect.x + rect.width && cy >= rect.y && cy <= rect.y + rect.height;
}

/**
 * The open case's id read from OCR words, or null when no confident match sits in the header region.
 * Among the matches in the region, the topmost (then leftmost) word wins — the header id is above the
 * body — and its confidence is reported so the caller can see how it compares with the model's read.
 */
export function readCaseId(words: readonly OcrWord[], size: { width: number; height: number }, config: CaseIdReaderConfig): ClientCaseId | null {
  const normalize = config.normalize ?? stripSpace;
  const minConfidence = config.minConfidence ?? DEFAULT_MIN_CONFIDENCE;
  const rect = regionPixels(config.region, size);
  let best: { value: string; confidence: number; y: number; x: number } | null = null;
  for (const word of words) {
    const confidence = word.confidence ?? 1;
    if (confidence < minConfidence || !centreInside(word.bbox, rect)) continue;
    const value = normalize(word.text);
    if (!config.pattern.test(value)) continue;
    if (best === null || word.bbox.y < best.y || (word.bbox.y === best.y && word.bbox.x < best.x))
      best = { value, confidence, y: word.bbox.y, x: word.bbox.x };
  }
  return best === null ? null : { value: best.value, confidence: best.confidence };
}

/** Reads the case id from each frame's OCR words, carrying the last confident read forward. */
export type CaseIdTracker = {
  /**
   * Reads `words`, which OCR produced for `ocrRegion` of a frame of `size`; updates and returns the
   * current id. No match carries the last id forward — unless the OCR region covered the header band,
   * in which case the header shows no id (a list, an empty or unrelated screen): no case is open.
   */
  read(words: readonly OcrWord[], size: { width: number; height: number }, ocrRegion: Rect): ClientCaseId | null;
  current(): ClientCaseId | null;
  /** Forgets the carried id (e.g. after resuming capture or going off the record). */
  reset(): void;
};

/** Share of the header band the OCR region must cover for "no id found" to mean "no case open". */
const HEADER_COVERED_SHARE = 0.5;

function coversHeader(region: Rect, header: Rect): boolean {
  const w = Math.min(region.x + region.width, header.x + header.width) - Math.max(region.x, header.x);
  const h = Math.min(region.y + region.height, header.y + header.height) - Math.max(region.y, header.y);
  return w > 0 && h > 0 && (w * h) / (header.width * header.height) >= HEADER_COVERED_SHARE;
}

/**
 * Stateful wrapper over `readCaseId`. Most frames (a field edit, a scroll inside a case) do not
 * change the header, so OCR of their changed region shows no id and the last read is kept; a case
 * switch re-reads the whole panel, so the new id replaces it, and a screen whose re-read header shows
 * no id (measured: session boundaries on the fixture) clears it rather than leave a stale trusted id.
 */
export function createCaseIdTracker(config: CaseIdReaderConfig): CaseIdTracker {
  let current: ClientCaseId | null = null;
  return {
    read(words, size, ocrRegion) {
      const found = readCaseId(words, size, config);
      if (found !== null) current = found;
      else if (coversHeader(ocrRegion, regionPixels(config.region, size))) current = null;
      return current;
    },
    current: () => current,
    reset() {
      current = null;
    },
  };
}
