import { describe, expect, it } from "vitest";
import { WorkMapSchema, type WorkMap } from "@vashistha/core";
import { exportWorkMapJson, importWorkMapJson } from "../src";
import { DEMO_RULEBOOK_REVISION, DEMO_RULES } from "../demo/kyc-demo-rulebook";

const highRisk = DEMO_RULES.find((r) => r.id === "R-high-risk-country");
if (highRisk === undefined) throw new Error("fixture");

const WORK_MAP: WorkMap = WorkMapSchema.parse({
  format: "vashistha.workmap/1",
  id: "wm-1",
  domainId: "kycNorthstar",
  expertId: "expert-demo",
  sessionIds: ["session-1"],
  generatedAt: Date.UTC(2026, 9, 4, 12),
  schemaVersion: 1,
  rulebookRevision: DEMO_RULEBOOK_REVISION,
  steps: [
    {
      id: "step-1",
      order: 0,
      caseId: "NS-2026-0102",
      title: "Escalates the high-risk-country case",
      decision: { decisionFamily: "reviewOutcome", action: "enhancedReview", ledgerEntryId: "ledger-42" },
      frameIds: ["frame-1", "frame-2"],
      eventIds: ["event-7"],
      ruleIds: [highRisk.id],
      reasonQuotes: [highRisk.evidence[0]],
      guardrailIds: [highRisk.id],
    },
  ],
  rules: DEMO_RULES,
  coverage: {
    decisionsExplained: { explained: 3, total: 3 },
    unresolvedWitnesses: 0,
    acknowledgedWitnesses: 1,
    undefinedConcepts: 0,
    teachBackConfirmed: true,
    schemaVersion: 1,
    closed: true,
  },
  summary: "Non-authoritative summary — «unicode» ✓",
});

/** Rebuilds every object with its keys in reverse order. */
function reverseKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(reverseKeys);
  if (value === null || typeof value !== "object") return value;
  return Object.fromEntries(Object.entries(value).reverse().map(([k, v]) => [k, reverseKeys(v)]));
}

describe("Work Map JSON", () => {
  it("round-trips to an equal Work Map", () => {
    expect(importWorkMapJson(exportWorkMapJson(WORK_MAP))).toEqual(WORK_MAP);
  });

  it("is canonical: sorted keys, independent of key order, stable under re-export", () => {
    const text = exportWorkMapJson(WORK_MAP);
    expect(exportWorkMapJson(reverseKeys(WORK_MAP) as WorkMap)).toBe(text);
    expect(exportWorkMapJson(importWorkMapJson(text))).toBe(text);
    expect(text.endsWith("}\n")).toBe(true);
    const topKeys = Object.keys(JSON.parse(text) as object);
    expect(topKeys).toEqual([...topKeys].sort());
  });

  it("refuses invalid Work Maps in both directions", () => {
    expect(() => exportWorkMapJson({ ...WORK_MAP, sessionIds: [] })).toThrow();
    const text = exportWorkMapJson(WORK_MAP);
    expect(() => importWorkMapJson(text.replace('"vashistha.workmap/1"', '"vashistha.workmap/2"'))).toThrow();
    expect(() => importWorkMapJson(text.slice(0, -10))).toThrow(SyntaxError);
  });
});
