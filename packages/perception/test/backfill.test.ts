import { describe, expect, it } from "vitest";
import { loadFeatureModel, type ConceptDefinition } from "@vashistha/core";
import { CLAUDE_MODELS } from "@vashistha/core/server";
import { KYC_DOMAIN } from "@vashistha/core/domains/kyc";
import { BACKFILL_MAX_FRAMES, BACKFILL_SYSTEM, backfillOutputSchema, buildBackfillRequest, toBackfillReading } from "../src/backfill";

const model = loadFeatureModel(KYC_DOMAIN, [
  { definition: { name: "documentsComplete", label: "Documents complete", type: "boolean" } as ConceptDefinition, schemaVersion: 2 },
  { definition: { name: "directorTenureYears", label: "Director tenure", type: "number", min: 0, max: 60, integer: true, unit: "years" } as ConceptDefinition, schemaVersion: 3 },
]);
const frame = (frameId: string) => ({ frameId, base64Png: "iVBORw0KGgo=", width: 1568, height: 882 });

describe("buildBackfillRequest", () => {
  it("asks Haiku for exactly one concept of one case over the given frames, with a typed nullable value", () => {
    const req = buildBackfillRequest({ domain: model.domain, feature: "documentsComplete", caseId: "NS-2026-0101", frames: [frame("a"), frame("b")] });
    expect(req.model).toBe(CLAUDE_MODELS.frameEvents);
    expect(req.system).toBe(BACKFILL_SYSTEM);
    const content = req.messages[0]?.content;
    if (!Array.isArray(content)) throw new Error("expected blocks");
    expect(content.filter((b) => b.type === "image")).toHaveLength(2);
    const text = content.flatMap((b) => (b.type === "text" ? [b.text] : [])).join("\n");
    expect(text).toContain("Case: NS-2026-0101");
    expect(text).toContain('`documentsComplete` — "Documents complete"');
    // Only the one concept: no other feature of the catalogue is mentioned.
    expect(text).not.toContain("uboOwnershipPct");
    expect(req.schema.safeParse({ visible: true, value: true, evidence: "x" }).success).toBe(true);
    expect(req.schema.safeParse({ visible: false, value: null, evidence: "" }).success).toBe(true);
    expect(req.schema.safeParse({ visible: true, value: "yes", evidence: "" }).success).toBe(false);
  });

  it("refuses unknown features, no frames, too many frames and oversize frames", () => {
    const base = { domain: model.domain, caseId: "c" };
    expect(() => buildBackfillRequest({ ...base, feature: "nope", frames: [frame("a")] })).toThrow(RangeError);
    expect(() => buildBackfillRequest({ ...base, feature: "documentsComplete", frames: [] })).toThrow(RangeError);
    const many = Array.from({ length: BACKFILL_MAX_FRAMES + 1 }, (_, i) => frame(String(i)));
    expect(() => buildBackfillRequest({ ...base, feature: "documentsComplete", frames: many })).toThrow(RangeError);
    expect(() => buildBackfillRequest({ ...base, feature: "documentsComplete", frames: [{ ...frame("a"), width: 4000 }] })).toThrow(RangeError);
  });
});

describe("toBackfillReading", () => {
  it("accepts in-range values; 'not visible' and out-of-range/non-integer readings are failures, never coerced", () => {
    const tenure = (value: number | null, visible = true) => toBackfillReading({ visible, value, evidence: " Directors panel " }, model.domain, "directorTenureYears");
    expect(tenure(12)).toEqual({ ok: true, value: 12, evidence: "Directors panel" });
    expect(tenure(null, false)).toEqual({ ok: false, failure: "not_visible", evidence: "Directors panel" });
    expect(tenure(12, false)).toMatchObject({ ok: false, failure: "not_visible" });
    expect(tenure(61)).toMatchObject({ ok: false, failure: "invalid_value" });
    expect(tenure(2.5)).toMatchObject({ ok: false, failure: "invalid_value" });
    const feature = model.domain.features.find((f) => f.id === "directorTenureYears");
    if (feature === undefined) throw new Error("no concept feature");
    expect(backfillOutputSchema(feature).safeParse({ visible: true, value: 3, evidence: "" }).success).toBe(true);
  });
});
