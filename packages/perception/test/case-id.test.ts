import { describe, expect, it } from "vitest";
import { createCaseIdTracker, readCaseId, type CaseIdReaderConfig } from "../src/case-id";
import type { OcrWord } from "../src/privacy";

/** CaseDesk's config (mirrors apps/web/lib/client/capture/browser.ts), measured on a 1440×900 frame. */
const CONFIG: CaseIdReaderConfig = { pattern: /^NS-\d{4}-\d{4}$/, region: { x: 0.1, y: 0, width: 0.68, height: 0.2 } };
const SIZE = { width: 1440, height: 900 };

/** A word at CaseDesk-measured positions: header id x≈305 y≈67, queue ids x≈17, review id x≈1150. */
const word = (text: string, x: number, y: number, confidence?: number): OcrWord => ({
  text,
  line: 0,
  bbox: { x, y, width: 90, height: 14 },
  ...(confidence !== undefined && { confidence }),
});

describe("readCaseId (open case's header id, not the queue or review ids)", () => {
  it("keeps only the pattern match inside the header region, topmost first", () => {
    const words = [
      word("NS-2026-0302", 17, 213, 0.9), // queue row (x outside the region)
      word("NS-2026-0303", 1150, 216, 0.95), // review column (x and y outside)
      word("NS-2026-0301", 305, 67, 0.86), // the open case's header id
      word("Halvorsen", 305, 95, 0.9), // not an id
    ];
    expect(readCaseId(words, SIZE, CONFIG)).toEqual({ value: "NS-2026-0301", confidence: 0.86 });
    // Only queue/review ids in view: nothing in the header region → no client read (falls back to the model).
    expect(readCaseId([words[0]!, words[1]!], SIZE, CONFIG)).toBeNull();
  });

  it("treats a low-confidence read as no match, and defaults missing confidence to trusted", () => {
    expect(readCaseId([word("NS-2026-0301", 305, 67, 0.3)], SIZE, CONFIG)).toBeNull();
    expect(readCaseId([word("NS-2026-0301", 305, 67, 0.3)], SIZE, { ...CONFIG, minConfidence: 0.2 })).toEqual({ value: "NS-2026-0301", confidence: 0.3 });
    expect(readCaseId([word("NS-2026-0301", 305, 67)], SIZE, CONFIG)).toEqual({ value: "NS-2026-0301", confidence: 1 });
  });

  it("normalises whitespace before matching and rejects non-matching tokens", () => {
    expect(readCaseId([word(" NS-2026-0301 ", 305, 67, 0.8)], SIZE, CONFIG)).toEqual({ value: "NS-2026-0301", confidence: 0.8 });
    expect(readCaseId([word("NS-2026-030", 305, 67, 0.8)], SIZE, CONFIG)).toBeNull();
    expect(readCaseId([word("2026", 305, 67, 0.8)], SIZE, CONFIG)).toBeNull();
  });
});

describe("createCaseIdTracker (carries the last confident read forward)", () => {
  it("updates on a header read and keeps it when later frames show no id, until reset", () => {
    const tracker = createCaseIdTracker(CONFIG);
    expect(tracker.current()).toBeNull();
    const panel = { x: 0, y: 34, width: 1434, height: 682 }; // a case switch: the whole panel is re-read
    const edit = { x: 1130, y: 380, width: 200, height: 60 }; // a field edit: far from the header band
    expect(tracker.read([word("NS-2026-0301", 305, 67, 0.86)], SIZE, panel)).toEqual({ value: "NS-2026-0301", confidence: 0.86 });
    // A field edit: its changed region does not cover the header, so the id is carried forward.
    expect(tracker.read([word("medium", 1200, 400, 0.9)], SIZE, edit)).toEqual({ value: "NS-2026-0301", confidence: 0.86 });
    // A case switch re-reads the header: the id changes.
    expect(tracker.read([word("NS-2026-0302", 305, 67, 0.88)], SIZE, panel)).toEqual({ value: "NS-2026-0302", confidence: 0.88 });
    // The header is re-read and shows no id (a list screen): no case is open, the stale id is not kept.
    expect(tracker.read([word("Case queue", 305, 67, 0.9)], SIZE, panel)).toBeNull();
    tracker.read([word("NS-2026-0302", 305, 67, 0.88)], SIZE, panel);
    tracker.reset();
    expect(tracker.current()).toBeNull();
  });
});
