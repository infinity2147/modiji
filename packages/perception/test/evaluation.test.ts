import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { ActionIdSchema, FeatureIdSchema, type ScreenEvent } from "@vashistha/core";
import { KYC_DOMAIN } from "@vashistha/core/domains/kyc";
import {
  categorize,
  DEFAULT_MATCH_WINDOW,
  evaluate,
  FixtureSchema,
  formatReport,
  P2_THRESHOLDS,
  percentile,
  type VisionObservation,
} from "../src/evaluation";

let seq = 0;
function event(source: "dom" | "vision", t: number, e: Partial<ScreenEvent> & Pick<ScreenEvent, "kind">): ScreenEvent {
  seq += 1;
  return { id: `${source}-${seq}`, frameSeq: seq, captureTime: t, sessionEpoch: 0, confidence: 1, source, critical: false, ...e };
}
const fc = (caseId: string, field: string, to: string | boolean) => ({ kind: "field_change" as const, caseId, field: FeatureIdSchema.parse(field), to });
const act = (caseId: string, action: string) => ({ kind: "action" as const, caseId, action: ActionIdSchema.parse(action) });
const open = (caseId: string) => ({ kind: "open_case" as const, caseId });
const dom = (t: number, e: Parameters<typeof event>[2]) => event("dom", t, e);
const seen = (t: number, appliedAt: number, e: Parameters<typeof event>[2]): VisionObservation => ({ event: event("vision", t, e), appliedAt });

const A = "NS-2026-0101";
const B = "NS-2026-0102";

const DOM_EVENTS: ScreenEvent[] = [
  dom(1000, { kind: "navigate" }),
  dom(2000, open(A)),
  dom(3000, fc(A, "riskRating", "high")),
  dom(4000, fc(A, "riskRating", "low")),
  dom(5000, act(A, "approve")),
  dom(6000, open(B)),
  dom(7000, fc(B, "riskRating", "medium")),
  dom(8000, act(B, "reject")),
  dom(9000, act(B, "rateHigh")), // not terminal: non-critical
  dom(10000, fc(B, "riskRating", "high")),
];

const VISION: VisionObservation[] = [
  seen(1400, 2100, { kind: "navigate" }),
  seen(2400, 3000, open(A)),
  seen(3400, 4200, fc(A, "riskRating", "high")),
  // A riskRating → low: missed
  seen(3900, 4200, fc(A, "pep", true)), // invented: false critical
  seen(5400, 6500, act(A, "approve")),
  seen(6400, 7000, open(B)),
  seen(9000, 9500, fc(B, "riskRating", "medium")), // 2 s late: still inside the 5 s window
  seen(8400, 9000, act(B, "approve")), // wrong decision: false critical, and B reject is missed
  seen(9400, 9900, act(B, "rateHigh")),
  seen(10400, 11000, fc(B, "riskRating", "high")),
  seen(20000, 20500, open(A)), // nothing on the DOM side: non-critical false positive
];

describe("evaluate", () => {
  it("scores a synthetic session with known answers", () => {
    const report = evaluate({
      domain: KYC_DOMAIN,
      domEvents: DOM_EVENTS,
      vision: VISION,
      frameToEventMs: [400, 800, 1200, 1600, 2000, 2400, 2800, 3200, 3600, 4000],
    });
    expect(report.counts).toEqual({
      dom: { critical_field: 4, critical_action: 2, non_critical: 4 },
      vision: { critical_field: 4, critical_action: 2, non_critical: 5 },
    });
    expect(report.criticalFieldChangeRecall).toEqual({ numerator: 3, denominator: 4, value: 0.75 });
    expect(report.criticalActionRecall).toEqual({ numerator: 1, denominator: 2, value: 0.5 });
    expect(report.falseCriticalRate).toEqual({ numerator: 2, denominator: 6, value: 2 / 6 });
    expect(report.nonCritical.precision).toEqual({ numerator: 4, denominator: 5, value: 0.8 });
    expect(report.nonCritical.recall).toEqual({ numerator: 4, denominator: 4, value: 1 });
    expect(report.nonCritical.f1).toBeCloseTo((2 * 0.8) / 1.8, 12);
    expect(report.latency.frameToEventMs).toEqual({ n: 10, p50: 2000, p95: 4000 });
    // DOM event → matched vision event applied: 1100, 1000, 1200, 1500, 1000, 2500, 900, 1000.
    expect(report.latency.changeToEventMs).toEqual({ n: 8, p50: 1000, p95: 2500 });
    expect(report.missedCritical.map((e) => [e.captureTime, e.kind])).toEqual([
      [4000, "field_change"],
      [8000, "action"],
    ]);
    expect(report.falseCritical.map((e) => e.captureTime)).toEqual([3900, 8400]);
    expect(report.checks.map((c) => [c.metric, c.pass])).toEqual([
      ["critical field-change recall", false],
      ["critical action recall", false],
      ["false critical rate", false],
      ["p95 frame→event (ms)", false],
    ]);
    expect(report.pass).toBe(false);
  });

  it("passes when vision reproduces the DOM within the window and latency budget", () => {
    const vision = DOM_EVENTS.map((d) => ({ event: { ...d, id: `v-${d.id}`, source: "vision" as const, captureTime: d.captureTime + 400 }, appliedAt: d.captureTime + 1500 }));
    const report = evaluate({ domain: KYC_DOMAIN, domEvents: DOM_EVENTS, vision, frameToEventMs: [900, 1100, 2900] });
    expect(report.checks.every((c) => c.pass)).toBe(true);
    expect(report.pass).toBe(true);
    expect(report.nonCritical.f1).toBe(1);
  });

  it("matches inside [dom − before, dom + after] only, one-to-one", () => {
    const d = dom(50_000, fc(A, "riskRating", "high"));
    const at = (t: number) => seen(t, t + 100, fc(A, "riskRating", "high"));
    const run = (vision: VisionObservation[]) =>
      evaluate({ domain: KYC_DOMAIN, domEvents: [d], vision, frameToEventMs: [1] }).criticalFieldChangeRecall.value;
    expect(run([at(50_000 + DEFAULT_MATCH_WINDOW.afterMs)])).toBe(1);
    expect(run([at(50_000 - DEFAULT_MATCH_WINDOW.beforeMs)])).toBe(1);
    expect(run([at(50_001 + DEFAULT_MATCH_WINDOW.afterMs)])).toBe(0);
    expect(run([at(49_999 - DEFAULT_MATCH_WINDOW.beforeMs)])).toBe(0);
    // A second detection of the same change does not match twice: it is a false critical.
    const twice = evaluate({ domain: KYC_DOMAIN, domEvents: [d], vision: [at(50_400), at(50_900)], frameToEventMs: [1] });
    expect(twice.falseCriticalRate).toEqual({ numerator: 1, denominator: 2, value: 0.5 });
  });

  it("a metric without data fails rather than passing vacuously", () => {
    const report = evaluate({ domain: KYC_DOMAIN, domEvents: [], vision: [], frameToEventMs: [] });
    expect(report.checks.map((c) => [c.value, c.pass])).toEqual([
      [null, false],
      [null, false],
      [null, false],
      [null, false],
    ]);
    expect(formatReport(report)).toContain("n/a");
  });

  it("formats a table with PASS/FAIL per thresholded metric and the plan's numbers", () => {
    const text = formatReport(evaluate({ domain: KYC_DOMAIN, domEvents: DOM_EVENTS, vision: VISION, frameToEventMs: [500] }));
    expect(text).toMatch(/critical field-change recall\s+0\.750 \(3\/4\)\s+>= 0\.95\s+FAIL/);
    expect(text).toMatch(/p95 frame→event \(ms\)\s+500\s+<= 3000\s+PASS/);
    expect(text).toMatch(/non-critical F1\s+0\.889/);
    expect(text).toContain("OVERALL: FAIL");
  });
});

describe("evaluation helpers", () => {
  it("keeps the plan §11 thresholds", () => {
    expect(P2_THRESHOLDS).toEqual({ criticalFieldChangeRecall: 0.95, criticalActionRecall: 0.95, falseCriticalRate: 0.05, p95FrameToEventMs: 3000 });
  });

  it("nearest-rank percentile", () => {
    expect(percentile([], 95)).toBeNull();
    expect(percentile([5], 50)).toBe(5);
    expect(percentile([4, 1, 3, 2], 50)).toBe(2);
    expect(percentile([4, 1, 3, 2], 95)).toBe(4);
    expect(percentile(Array.from({ length: 100 }, (_, i) => i + 1), 95)).toBe(95);
  });

  it("categorises critical field changes and terminal actions as critical", () => {
    expect(categorize(dom(0, fc(A, "riskRating", "high")), KYC_DOMAIN)).toBe("critical_field");
    expect(categorize(dom(0, act(A, "approve")), KYC_DOMAIN)).toBe("critical_action");
    expect(categorize(dom(0, act(A, "rateLow")), KYC_DOMAIN)).toBe("non_critical");
    expect(categorize(dom(0, open(A)), KYC_DOMAIN)).toBe("non_critical");
  });
});

describe("FixtureSchema", () => {
  const raw = JSON.parse(readFileSync(join(import.meta.dirname, "fixtures/synthetic-kyc/fixture.json"), "utf8")) as {
    frames: Array<{ frameSeq: number; captureTime: number; file: string }>;
  };

  it("accepts the synthetic fixture", () => {
    const fixture = FixtureSchema.parse(raw);
    expect(fixture.frames).toHaveLength(48);
    expect(fixture.domEvents.length).toBeGreaterThan(0);
  });

  it("rejects non-increasing frames and paths escaping the fixture directory", () => {
    const [first, second] = raw.frames;
    if (!first || !second) throw new Error("fixture too short");
    expect(FixtureSchema.safeParse({ ...raw, frames: [second, first] }).success).toBe(false);
    expect(FixtureSchema.safeParse({ ...raw, frames: [{ ...first, file: "../secret.png" }] }).success).toBe(false);
    expect(FixtureSchema.safeParse({ ...raw, frames: [{ ...first, file: "/etc/x.png" }] }).success).toBe(false);
  });
});
