/**
 * Best-effort client-side PII redaction for screen frames (plan §7.1, §7.8).
 *
 * What it does: OCR (Tesseract.js) reads word boxes in the changed region; lines are classified by
 * regular expressions (emails, phone numbers, IBANs, long account-like digit runs, dates of birth
 * next to a birth cue, registration numbers, passport/ID-like tokens, MRZ lines) and by a caller-
 * supplied list of person names; matching word boxes are pixelated irreversibly (each block at
 * least as tall as the box). Boxes persist across frames until their region changes, so PII found
 * once stays covered in later full-frame uploads.
 *
 * Limits — say these, never more: OCR misses text (small fonts, low contrast, unusual layouts,
 * text rendered in images); regexes miss unconventional formats and catch some non-PII; the name
 * list only knows the names it is given; a frame is redacted only where OCR has looked, and only
 * the changed region is re-read. This is best-effort. The real guarantee for the hackathon demo
 * is that every person, company, number and address in CaseDesk is synthetic.
 *
 * Isomorphic except `createTesseractOcr`, which needs a browser (OffscreenCanvas, Web Worker).
 */
import { createWorker, OEM, type Worker } from "tesseract.js";
import {
  clampRect,
  cloneRgba,
  cropRgba,
  padRect,
  rectsIntersect,
  unionRect,
  type Rect,
  type RgbaImage,
} from "./image";

/** A word read by OCR, in full-frame pixel coordinates. Words with the same `line` share a text line. */
export type OcrWord = { text: string; bbox: Rect; line: number };

/** Reads the words inside `region` of `image`; returned boxes are in `image` coordinates. */
export type OcrFn = (image: RgbaImage, region: Rect) => Promise<OcrWord[]>;

export const PII_KINDS = [
  "email",
  "phone",
  "iban",
  "account_number",
  "date_of_birth",
  "registration_number",
  "id_document",
  "person_name",
] as const;
export type PiiKind = (typeof PII_KINDS)[number];

export type PiiBox = { kind: PiiKind; box: Rect };

const MONTH = "(?:jan|feb|mar|apr|may|jun|jul|aug|sep|sept|oct|nov|dec)[a-z]*\\.?";
const DATE = new RegExp(
  `\\b(?:\\d{1,2}[./-]\\d{1,2}[./-]\\d{2,4}|\\d{4}-\\d{2}-\\d{2}|\\d{1,2}\\s+${MONTH}\\s+\\d{4}|${MONTH}\\s+\\d{1,2},?\\s+\\d{4})\\b`,
  "gi",
);
const BIRTH_CUE = /\b(?:d\.?o\.?b\.?|date\s+of\s+birth|birth\s*date|born)\b/i;

/** Regex classifiers over one OCR line. Order matters only for the reported kind of overlapping matches. */
const LINE_PATTERNS: ReadonlyArray<{ kind: PiiKind; pattern: RegExp; accept?: (match: string) => boolean }> = [
  { kind: "email", pattern: /[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)+/g },
  { kind: "iban", pattern: /\b[A-Z]{2}\d{2}(?: ?[A-Z0-9]{4}){2,7}(?: ?[A-Z0-9]{1,3})?\b/g },
  {
    // International (+44 …, 0044 …) or bracketed area code; 8–15 digits in total.
    kind: "phone",
    pattern: /(?:(?:\+|\b00)\d{1,3}[\s.-]?(?:\(\d{1,4}\)[\s.-]?)?|\(\d{2,5}\)[\s.-]?)\d{2,4}(?:[\s.-]?\d{2,4}){1,4}\b/g,
    accept: (m) => digitCount(m) >= 8 && digitCount(m) <= 15,
  },
  {
    // ≥9 digits run together, dash-grouped, or in space-separated groups of four (card/account style).
    kind: "account_number",
    pattern: /\b(?:\d{9,}|\d{2,6}(?:-\d{2,6}){1,5}|\d{4}(?: \d{4}){2,5})\b/g,
    accept: (m) => digitCount(m) >= 9,
  },
  { kind: "registration_number", pattern: /\b[A-Z]{2,4}-[A-Z]{0,2}\d{5,10}\b/g },
  { kind: "id_document", pattern: /\b(?=[A-Z0-9]*\d)(?=[A-Z0-9]*[A-Z])[A-Z0-9]{7,12}\b/g },
  { kind: "id_document", pattern: /[A-Z0-9<]{20,}/g, accept: (m) => m.includes("<<") },
];

function digitCount(text: string): number {
  return text.replace(/\D/g, "").length;
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Character ranges of `text` matched by the name list: full names, and each name part of 3+ letters as a whole word. */
function nameRanges(text: string, names: readonly string[]): Array<[number, number]> {
  const parts = new Set<string>();
  const phrases: string[] = [];
  for (const name of names) {
    const tokens = name.trim().split(/\s+/).filter((t) => t.length > 0);
    if (tokens.length === 0) continue;
    phrases.push(tokens.map(escapeRegExp).join("\\s+"));
    for (const t of tokens) if (t.replace(/[^\p{L}]/gu, "").length >= 3) parts.add(escapeRegExp(t));
  }
  const alternatives = [...phrases, ...parts];
  if (alternatives.length === 0) return [];
  // Longest first so a full name wins over its parts; \p{L} lookarounds instead of \b for non-ASCII names.
  alternatives.sort((a, b) => b.length - a.length);
  const pattern = new RegExp(`(?<![\\p{L}\\p{N}])(?:${alternatives.join("|")})(?![\\p{L}\\p{N}])`, "giu");
  return [...text.matchAll(pattern)].map((m) => [m.index, m.index + m[0].length]);
}

/** PII character ranges in one line of text. Exported for tests and for non-OCR text (e.g. DOM strings). */
export function classifyLine(text: string, names: readonly string[] = []): Array<{ kind: PiiKind; start: number; end: number }> {
  const found: Array<{ kind: PiiKind; start: number; end: number }> = [];
  for (const { kind, pattern, accept } of LINE_PATTERNS)
    for (const m of text.matchAll(pattern))
      if (accept === undefined || accept(m[0])) found.push({ kind, start: m.index, end: m.index + m[0].length });
  if (BIRTH_CUE.test(text))
    for (const m of text.matchAll(DATE)) found.push({ kind: "date_of_birth", start: m.index, end: m.index + m[0].length });
  for (const [start, end] of nameRanges(text, names)) found.push({ kind: "person_name", start, end });
  return found.sort((a, b) => a.start - b.start || b.end - a.end);
}

/** Boxes of the words that overlap a PII match, one box per word, joined into lines by `line`. */
export function findPiiBoxes(words: readonly OcrWord[], names: readonly string[] = []): PiiBox[] {
  const lines = new Map<number, OcrWord[]>();
  for (const w of words) if (w.text.trim() !== "") lines.set(w.line, [...(lines.get(w.line) ?? []), w]);
  const boxes: PiiBox[] = [];
  for (const lineWords of lines.values()) {
    lineWords.sort((a, b) => a.bbox.x - b.bbox.x);
    let text = "";
    const spans = lineWords.map((w) => {
      const start = text.length === 0 ? 0 : text.length + 1;
      text = text.length === 0 ? w.text : `${text} ${w.text}`;
      return { word: w, start, end: start + w.text.length };
    });
    const hit = new Map<OcrWord, PiiKind>();
    for (const match of classifyLine(text, names))
      for (const span of spans)
        if (span.start < match.end && match.start < span.end && !hit.has(span.word)) hit.set(span.word, match.kind);
    for (const [word, kind] of hit) boxes.push({ kind, box: word.bbox });
  }
  return boxes;
}

/**
 * Pixelates each box (clipped to the image) on a copy of `image`. Blocks are at least as tall as
 * the box, so glyph shapes do not survive; pixels outside every box are untouched.
 */
export function pixelateBoxes(image: RgbaImage, boxes: readonly Rect[], minBlock = 8): RgbaImage {
  const out = cloneRgba(image);
  for (const raw of boxes) {
    const box = clampRect(raw, image.width, image.height);
    if (box === null) continue;
    const block = Math.max(minBlock, box.height);
    for (let by = box.y; by < box.y + box.height; by += block)
      for (let bx = box.x; bx < box.x + box.width; bx += block) {
        const x1 = Math.min(bx + block, box.x + box.width);
        const y1 = Math.min(by + block, box.y + box.height);
        const sum = [0, 0, 0, 0];
        for (let y = by; y < y1; y += 1)
          for (let x = bx; x < x1; x += 1) {
            const i = (y * image.width + x) * 4;
            for (let c = 0; c < 4; c += 1) sum[c] = (sum[c] ?? 0) + (image.data[i + c] ?? 0);
          }
        const n = (x1 - bx) * (y1 - by);
        for (let y = by; y < y1; y += 1)
          for (let x = bx; x < x1; x += 1) {
            const i = (y * image.width + x) * 4;
            for (let c = 0; c < 4; c += 1) out.data[i + c] = Math.round((sum[c] ?? 0) / n);
          }
      }
  }
  return out;
}

export type RedactionResult = {
  image: RgbaImage;
  /** Every box applied to this frame (carried over and new). */
  boxes: PiiBox[];
  /** Region OCR read this time. */
  ocrRegion: Rect;
};

export type Redactor = {
  /**
   * Redacts `image`. `changed` is the change detector's bbox; null (or a new frame size) re-reads the
   * whole frame. Rejects if OCR fails: the caller must then not upload the frame (fail closed).
   */
  redact(image: RgbaImage, changed: Rect | null): Promise<RedactionResult>;
  /** Forgets carried-over boxes (e.g. after resuming capture). */
  reset(): void;
};

export function createRedactor(options: {
  ocr: OcrFn;
  /** Person names to redact wherever they appear (e.g. the synthetic case's people); read on every frame. */
  names: () => readonly string[];
  /** Padding around each word box, px. */
  padding?: number;
}): Redactor {
  const padding = options.padding ?? 2;
  let carried: PiiBox[] = [];
  let size: { width: number; height: number } | null = null;
  let busy = false;

  return {
    async redact(image, changed) {
      if (busy) throw new Error("redact() is already running; frames must be redacted one at a time");
      busy = true;
      try {
        const full: Rect = { x: 0, y: 0, width: image.width, height: image.height };
        const sameSize = size !== null && size.width === image.width && size.height === image.height;
        const partial = sameSize && changed !== null;
        let region = partial ? (clampRect(changed, image.width, image.height) ?? full) : full;
        // Re-read every carried box the change touches, whole, so a word cut by the region edge is not lost.
        for (const b of carried) if (rectsIntersect(b.box, region)) region = unionRect(region, b.box);
        region = clampRect(region, image.width, image.height) ?? full;
        const kept = partial ? carried.filter((b) => !rectsIntersect(b.box, region)) : [];
        const words = await options.ocr(image, region);
        const found = findPiiBoxes(words, options.names()).map((b) => ({ kind: b.kind, box: padRect(b.box, padding) }));
        carried = [...kept, ...found];
        size = { width: image.width, height: image.height };
        return { image: pixelateBoxes(image, carried.map((b) => b.box)), boxes: carried, ocrRegion: region };
      } finally {
        busy = false;
      }
    },
    reset() {
      carried = [];
      size = null;
    },
  };
}

/**
 * Tesseract.js OCR served from OUR origin (no third-party CDN at demo time). `basePath` (e.g.
 * "/tesseract/") must serve, as produced by `scripts/vendor-tesseract.ts`:
 *
 * - `worker.min.js` (tesseract.js 7 worker script);
 * - `tesseract-core-lstm.wasm.js`, `tesseract-core-simd-lstm.wasm.js`,
 *   `tesseract-core-relaxedsimd-lstm.wasm.js` (LSTM-only cores with the wasm embedded; the worker
 *   picks one by CPU feature detection);
 * - `eng.traineddata.gz` (tessdata_fast English model).
 *
 * The region is upscaled by `scale` (default 2) before recognition: UI text at 1× device pixels is
 * too small for Tesseract (on a 1440×900 CaseDesk screenshot, 1× missed the registration number
 * and a manager's name; 2× found both). Cost grows with the area OCR reads: a whole 1440×900
 * frame at 2× took ≈3 s in Node (single-threaded wasm); a small changed region is far cheaper.
 *
 * `largeRegion` trades some of that for latency where it is spent: a read region covering at least
 * `share` of the frame (case switches, scrolls — the slow OCRs) is upscaled by `scale` instead.
 * `e2e/perception-ocr-latency.spec.ts` measures latency and PII-box recall for each setting.
 *
 * The worker is created on first use. Browser only.
 */
export type OcrScale = { scale?: number; largeRegion?: { share: number; scale: number } };

export function createTesseractOcr(options: { basePath: string; lang?: string } & OcrScale): {
  ocr: OcrFn;
  terminate(): Promise<void>;
} {
  const baseScale = options.scale ?? 2;
  const { largeRegion } = options;
  const base = options.basePath.endsWith("/") ? options.basePath : `${options.basePath}/`;
  let worker: Promise<Worker> | null = null;
  const getWorker = (): Promise<Worker> => {
    worker ??= createWorker(options.lang ?? "eng", OEM.LSTM_ONLY, {
      workerPath: `${base}worker.min.js`,
      corePath: base,
      langPath: base,
      gzip: true,
      workerBlobURL: false,
    });
    return worker;
  };

  return {
    async ocr(image, region) {
      const crop = cropRgba(image, region);
      const large = largeRegion !== undefined && crop.width * crop.height >= largeRegion.share * image.width * image.height;
      const scale = large ? largeRegion.scale : baseScale;
      const origin = clampRect(region, image.width, image.height) ?? region;
      const source = new OffscreenCanvas(crop.width, crop.height);
      const canvas = new OffscreenCanvas(Math.round(crop.width * scale), Math.round(crop.height * scale));
      const sourceContext = source.getContext("2d");
      const context = canvas.getContext("2d");
      if (sourceContext === null || context === null) throw new Error("OffscreenCanvas 2D context unavailable");
      sourceContext.putImageData(new ImageData(crop.data, crop.width, crop.height), 0, 0);
      context.imageSmoothingQuality = "high";
      context.drawImage(source, 0, 0, canvas.width, canvas.height);
      const { data } = await (await getWorker()).recognize(canvas, {}, { blocks: true });
      const words: OcrWord[] = [];
      let line = 0;
      for (const block of data.blocks ?? [])
        for (const paragraph of block.paragraphs)
          for (const l of paragraph.lines) {
            for (const w of l.words)
              words.push({
                text: w.text,
                line,
                bbox: {
                  x: origin.x + w.bbox.x0 / scale,
                  y: origin.y + w.bbox.y0 / scale,
                  width: (w.bbox.x1 - w.bbox.x0) / scale,
                  height: (w.bbox.y1 - w.bbox.y0) / scale,
                },
              });
            line += 1;
          }
      return words;
    },
    async terminate() {
      if (worker === null) return;
      const w = worker;
      worker = null;
      await (await w).terminate();
    },
  };
}
