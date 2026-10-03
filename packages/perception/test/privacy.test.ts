import { describe, expect, it } from "vitest";
import { createRgba, type Rect, type RgbaImage } from "../src/image";
import { classifyLine, createRedactor, findPiiBoxes, pixelateBoxes, type OcrFn, type OcrWord, type PiiKind } from "../src/privacy";

const kinds = (text: string, names: string[] = []): PiiKind[] => classifyLine(text, names).map((m) => m.kind);
const matched = (text: string, names: string[] = []): string[] => classifyLine(text, names).map((m) => text.slice(m.start, m.end));

describe("PII line classifiers", () => {
  it.each([
    ["Contact: ingrid.halvorsen@example.test", "email", "ingrid.halvorsen@example.test"],
    ["Phone +44 20 7946 0958", "phone", "+44 20 7946 0958"],
    ["Tel (020) 7946 0958", "phone", "(020) 7946 0958"],
    ["IBAN DE89 3704 0044 0532 0130 00", "iban", "DE89 3704 0044 0532 0130 00"],
    ["Account 123456789012", "account_number", "123456789012"],
    ["Card 4111 1111 1111 1111", "account_number", "4111 1111 1111 1111"],
    ["Date of birth 12/04/1987", "date_of_birth", "12/04/1987"],
    ["DOB: 3 March 1990", "date_of_birth", "3 March 1990"],
    ["Registration no. EST-C482913", "registration_number", "EST-C482913"],
    ["Passport X1234567", "id_document", "X1234567"],
    ["P<ESTHALVORSEN<<INGRID<<<<<<<<<<<<", "id_document", "P<ESTHALVORSEN<<INGRID<<<<<<<<<<<<"],
  ] as const)("%s → %s", (text, kind, expected) => {
    const found = classifyLine(text).filter((m) => m.kind === kind);
    expect(found.map((m) => text.slice(m.start, m.end))).toContain(expected);
  });

  it("leaves case ids, amounts, plain dates, percentages and short ids alone", () => {
    for (const text of [
      "NS-2026-0101 Halvorsen Marine Logistics Ltd",
      "Expected monthly volume €18,000",
      "Expected monthly volume 10 000 000 EUR",
      "Submitted 14 Sept 2026",
      "Submitted 2026-09-14",
      "Share 35 % Verified",
      "Ledger entry 7cf1887d",
    ])
      expect(kinds(text), text).toEqual([]);
  });

  it("matches supplied names: full names, and parts of 3+ letters as whole words, case-insensitively", () => {
    const names = ["Ingrid Halvorsen", "Tomasz Okonkwo-Hale", "Jo Li"];
    expect(matched("Director: Ingrid  Halvorsen", names)).toEqual(["Ingrid  Halvorsen"]);
    expect(matched("Passport — HALVORSEN", names)).toEqual(["HALVORSEN"]);
    expect(matched("Okonkwo-Hale signed", names)).toEqual(["Okonkwo-Hale"]);
    expect(matched("Halvorsenbank Ingridson", names)).toEqual([]); // whole words only
    expect(matched("Jo Li and Jo", names)).toEqual(["Jo Li"]); // 2-letter parts alone are too ambiguous
  });

  it("a date without a birth cue on the line is not PII", () => {
    expect(kinds("Review date 12/04/1987")).toEqual([]);
  });
});

describe("findPiiBoxes", () => {
  const word = (text: string, x: number, line: number): OcrWord => ({ text, line, bbox: { x, y: line * 20, width: text.length * 8, height: 14 } });

  it("maps a match spanning several words back to every word box", () => {
    const words = [word("Phone", 0, 0), word("+44", 60, 0), word("20", 100, 0), word("7946", 130, 0), word("0958", 175, 0), word("Status", 0, 1)];
    const boxes = findPiiBoxes(words);
    expect(boxes.map((b) => b.kind)).toEqual(["phone", "phone", "phone", "phone"]);
    expect(boxes.map((b) => b.box.x)).toEqual([60, 100, 130, 175]);
  });

  it("keeps lines apart and orders words by x within a line", () => {
    const words = [word("Halvorsen", 80, 0), word("Ingrid", 0, 0), word("Ingrid", 0, 1), word("Okafor", 60, 1)];
    const boxes = findPiiBoxes(words, ["Ingrid Halvorsen"]);
    // Line 0: the full name (both words). Line 1: "Ingrid" alone is a supplied name part.
    expect(boxes.map((b) => `${b.box.x},${b.box.y}`).sort()).toEqual(["0,0", "0,20", "80,0"]);
  });
});

function patterned(width: number, height: number): RgbaImage {
  const img = createRgba(width, height);
  for (let y = 0; y < height; y += 1)
    for (let x = 0; x < width; x += 1) img.data.set([(x * 37 + y * 11) % 256, (x * 7) % 256, (y * 13) % 256, 255], (y * width + x) * 4);
  return img;
}

function inside(x: number, y: number, boxes: Rect[]): boolean {
  return boxes.some((b) => x >= b.x && x < b.x + b.width && y >= b.y && y < b.y + b.height);
}

describe("pixelateBoxes", () => {
  it("alters pixels inside the boxes only, on a copy", () => {
    const img = patterned(120, 80);
    const original = new Uint8ClampedArray(img.data);
    const boxes: Rect[] = [
      { x: 10, y: 10, width: 40, height: 14 },
      { x: 100, y: 70, width: 50, height: 30 }, // clipped at the image edge
    ];
    const out = pixelateBoxes(img, boxes);
    expect(img.data).toEqual(original);
    let changedInside = 0;
    for (let y = 0; y < img.height; y += 1)
      for (let x = 0; x < img.width; x += 1) {
        const i = (y * img.width + x) * 4;
        const same = [0, 1, 2, 3].every((c) => out.data[i + c] === img.data[i + c]);
        if (!inside(x, y, boxes)) expect(same, `pixel ${x},${y} outside the boxes changed`).toBe(true);
        else if (!same) changedInside += 1;
      }
    // Blocks are as tall as the box, so nearly every patterned pixel inside is replaced by a block mean.
    expect(changedInside).toBeGreaterThan(0.9 * (40 * 14 + 20 * 10));
  });

  it("leaves a box's pixels uniform per block (glyph shapes do not survive)", () => {
    const out = pixelateBoxes(patterned(64, 32), [{ x: 0, y: 0, width: 14, height: 14 }]);
    const first = [...out.data.subarray(0, 4)];
    for (let y = 0; y < 14; y += 1)
      for (let x = 0; x < 14; x += 1) expect([...out.data.subarray((y * 64 + x) * 4, (y * 64 + x) * 4 + 4)]).toEqual(first);
  });
});

describe("createRedactor", () => {
  /** OCR stub: returns the configured words that fall inside the requested region; records each region. */
  function stubOcr(words: OcrWord[]): { ocr: OcrFn; regions: Rect[] } {
    const regions: Rect[] = [];
    return {
      regions,
      ocr: async (_image, region) => {
        regions.push(region);
        return words.filter((w) => inside(w.bbox.x, w.bbox.y, [region]));
      },
    };
  }

  const nameWord: OcrWord = { text: "Halvorsen", line: 0, bbox: { x: 20, y: 20, width: 60, height: 12 } };
  const emailWord: OcrWord = { text: "a@b.test", line: 1, bbox: { x: 200, y: 100, width: 60, height: 12 } };

  it("reads the whole first frame, then only the changed region, carrying earlier boxes over", async () => {
    const { ocr, regions } = stubOcr([nameWord, emailWord]);
    const redactor = createRedactor({ ocr, names: () => ["Ingrid Halvorsen"] });
    const frame = patterned(320, 180);
    const first = await redactor.redact(frame, { x: 0, y: 0, width: 5, height: 5 });
    expect(regions[0]).toEqual({ x: 0, y: 0, width: 320, height: 180 }); // first frame: full read regardless of bbox
    expect(first.boxes.map((b) => b.kind).sort()).toEqual(["email", "person_name"]);

    const second = await redactor.redact(frame, { x: 150, y: 140, width: 40, height: 20 });
    expect(regions[1]).toEqual({ x: 150, y: 140, width: 40, height: 20 });
    expect(second.boxes.map((b) => b.kind).sort()).toEqual(["email", "person_name"]); // carried over, still blurred
    const i = (26 * 320 + 30) * 4;
    expect([...second.image.data.subarray(i, i + 4)]).not.toEqual([...frame.data.subarray(i, i + 4)]);
  });

  it("re-reads a carried box the change touches, whole, and drops it if the text is gone", async () => {
    const words = [nameWord];
    const redactor = createRedactor({ ocr: async (_img, region) => words.filter((w) => inside(w.bbox.x, w.bbox.y, [region])), names: () => ["Halvorsen"] });
    const frame = patterned(320, 180);
    await redactor.redact(frame, null);
    words.length = 0; // the name disappeared from the screen
    const result = await redactor.redact(frame, { x: 70, y: 25, width: 10, height: 5 });
    expect(result.ocrRegion.x).toBeLessThanOrEqual(18); // grown to the padded carried box
    expect(result.boxes).toEqual([]);
  });

  it("fails closed: an OCR error rejects, and the redactor stays usable", async () => {
    let fail = true;
    const redactor = createRedactor({
      ocr: async () => {
        if (fail) throw new Error("wasm failed to load");
        return [];
      },
      names: () => [],
    });
    await expect(redactor.redact(patterned(32, 32), null)).rejects.toThrow("wasm failed to load");
    fail = false;
    await expect(redactor.redact(patterned(32, 32), null)).resolves.toMatchObject({ boxes: [] });
  });

  it("refuses concurrent redaction", async () => {
    let release = (): void => undefined;
    const redactor = createRedactor({
      ocr: () => new Promise<OcrWord[]>((resolve) => (release = () => resolve([]))),
      names: () => [],
    });
    const first = redactor.redact(patterned(32, 32), null);
    await expect(redactor.redact(patterned(32, 32), null)).rejects.toThrow("already running");
    release();
    await first;
  });
});
