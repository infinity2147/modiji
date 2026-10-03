/**
 * P2 perception acceptance (plan §11): vision events scored against the CaseDesk DOM channel as
 * ground truth on a recorded fixture (format: FIXTURES.md). Isomorphic and pure.
 *
 * Matching: a vision event matches a DOM event with the same (kind, caseId, field/action, to)
 * whose captureTime is within [dom − beforeMs, dom + afterMs]; one-to-one, DOM events in time
 * order, each taking the earliest eligible vision event.
 *
 * Categories (derived from the domain, identically for both sides):
 * - critical field change: field_change of a `criticalFields` member (= ScreenEvent.critical);
 * - critical action: an action whose definition is `terminal` (a committed decision — a false one
 *   is as dangerous as a missed one, so it counts toward the false critical rate too);
 * - everything else (navigate, open_case, other field changes and actions) is non-critical.
 */
import { z } from "zod";
import { EpochMsSchema, ScreenEventSchema, type DomainConfig, type ScreenEvent } from "@vashistha/core";

/** Plan §11 P2 thresholds. Fixed by the plan: never tune these to make a run pass. */
export const P2_THRESHOLDS = {
  criticalFieldChangeRecall: 0.95,
  criticalActionRecall: 0.95,
  falseCriticalRate: 0.05,
  p95FrameToEventMs: 3000,
} as const;

export type MatchWindow = { beforeMs: number; afterMs: number };
/** A frame is captured every 500 ms and may wait for one request in flight; 5 s covers a slow pair. */
export const DEFAULT_MATCH_WINDOW: MatchWindow = { beforeMs: 1000, afterMs: 5000 };

const FixtureFrameSchema = z.strictObject({
  frameSeq: z.int().positive(),
  captureTime: EpochMsSchema,
  /** PNG path relative to the fixture directory; no parent traversal. */
  file: z
    .string()
    .regex(/^[A-Za-z0-9_][A-Za-z0-9_./-]*\.png$/, "relative .png path")
    .refine((f) => !f.split("/").includes(".."), "must not contain ..")
});

/** `fixture.json` of a recorded session; see FIXTURES.md. */
export const FixtureSchema = z
  .strictObject({
    version: z.literal(1),
    domainId: z.string().min(1),
    sessionEpoch: z.int().nonnegative(),
    frames: z.array(FixtureFrameSchema).min(1),
    domEvents: z.array(ScreenEventSchema),
  })
  .superRefine((fx, ctx) => {
    fx.frames.forEach((f, i) => {
      const prev = fx.frames[i - 1];
      if (prev && (f.frameSeq <= prev.frameSeq || f.captureTime <= prev.captureTime))
        ctx.addIssue({ code: "custom", path: ["frames", i], message: "frameSeq and captureTime must strictly increase" });
    });
    fx.domEvents.forEach((e, i) => {
      if (e.source !== "dom") ctx.addIssue({ code: "custom", path: ["domEvents", i, "source"], message: 'must be "dom"' });
      if (e.sessionEpoch !== fx.sessionEpoch)
        ctx.addIssue({ code: "custom", path: ["domEvents", i, "sessionEpoch"], message: "must equal the fixture sessionEpoch" });
    });
  });
export type Fixture = z.infer<typeof FixtureSchema>;

export type EventCategory = "critical_field" | "critical_action" | "non_critical";

export function categorize(event: ScreenEvent, domain: DomainConfig): EventCategory {
  if (event.kind === "field_change" && event.field !== undefined && domain.criticalFields.includes(event.field)) return "critical_field";
  if (event.kind === "action" && domain.actions.find((a) => a.id === event.action)?.terminal === true) return "critical_action";
  return "non_critical";
}

function matchKey(e: ScreenEvent): string {
  return e.kind === "navigate"
    ? "navigate"
    : JSON.stringify([e.kind, e.caseId ?? null, e.field ?? null, e.action ?? null, e.to ?? null]);
}

/** A vision event and when the session applied it (same timebase as captureTime). */
export type VisionObservation = { event: ScreenEvent; appliedAt: number };

export type Ratio = { numerator: number; denominator: number; value: number | null };
export type LatencySummary = { n: number; p50: number | null; p95: number | null };

export type Check = { metric: string; value: number | null; comparator: ">=" | "<="; threshold: number; pass: boolean };

export type EvaluationReport = {
  counts: { dom: Record<EventCategory, number>; vision: Record<EventCategory, number> };
  criticalFieldChangeRecall: Ratio;
  criticalActionRecall: Ratio;
  falseCriticalRate: Ratio;
  nonCritical: { precision: Ratio; recall: Ratio; f1: number | null };
  latency: {
    /** Frame capture → its events applied (one sample per applied frame). The thresholded metric. */
    frameToEventMs: LatencySummary;
    /** DOM event → matching vision event applied (reported; includes waiting for the next changed frame). */
    changeToEventMs: LatencySummary;
  };
  checks: Check[];
  pass: boolean;
  /** Critical DOM events vision missed, and critical vision events with no DOM counterpart. */
  missedCritical: ScreenEvent[];
  falseCritical: ScreenEvent[];
};

const ratio = (numerator: number, denominator: number): Ratio => ({
  numerator,
  denominator,
  value: denominator === 0 ? null : numerator / denominator,
});

/** Nearest-rank percentile (p in 0–100); null for no samples. */
export function percentile(samples: readonly number[], p: number): number | null {
  if (samples.length === 0) return null;
  const sorted = [...samples].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1))] ?? null;
}

const summary = (samples: readonly number[]): LatencySummary => ({
  n: samples.length,
  p50: percentile(samples, 50),
  p95: percentile(samples, 95),
});

/** A metric without data fails: a run cannot pass on what it did not measure. */
function check(metric: string, value: number | null, comparator: ">=" | "<=", threshold: number): Check {
  const pass = value !== null && (comparator === ">=" ? value >= threshold : value <= threshold);
  return { metric, value, comparator, threshold, pass };
}

export function evaluate(input: {
  domain: DomainConfig;
  domEvents: readonly ScreenEvent[];
  vision: readonly VisionObservation[];
  /** Per applied frame: appliedAt − captureTime (the queue's `frameToApplyMs`). */
  frameToEventMs: readonly number[];
  window?: MatchWindow;
}): EvaluationReport {
  const { domain } = input;
  const window = input.window ?? DEFAULT_MATCH_WINDOW;
  const dom = [...input.domEvents].sort((a, b) => a.captureTime - b.captureTime);
  const vision = [...input.vision].sort((a, b) => a.event.captureTime - b.event.captureTime || a.appliedAt - b.appliedAt);
  const matchedVision = new Set<VisionObservation>();
  const matchedDom = new Map<ScreenEvent, VisionObservation>();

  for (const d of dom) {
    const key = matchKey(d);
    const hit = vision.find(
      (v) =>
        !matchedVision.has(v) &&
        matchKey(v.event) === key &&
        v.event.captureTime >= d.captureTime - window.beforeMs &&
        v.event.captureTime <= d.captureTime + window.afterMs,
    );
    if (hit) {
      matchedVision.add(hit);
      matchedDom.set(d, hit);
    }
  }

  const zero = (): Record<EventCategory, number> => ({ critical_field: 0, critical_action: 0, non_critical: 0 });
  const domCounts = zero();
  const domHits = zero();
  const visionCounts = zero();
  const visionHits = zero();
  const missedCritical: ScreenEvent[] = [];
  const falseCritical: ScreenEvent[] = [];
  const changeToEvent: number[] = [];
  for (const d of dom) {
    const category = categorize(d, domain);
    domCounts[category] += 1;
    const hit = matchedDom.get(d);
    if (hit) {
      domHits[category] += 1;
      changeToEvent.push(hit.appliedAt - d.captureTime);
    } else if (category !== "non_critical") missedCritical.push(d);
  }
  for (const v of vision) {
    const category = categorize(v.event, domain);
    visionCounts[category] += 1;
    if (matchedVision.has(v)) visionHits[category] += 1;
    else if (category !== "non_critical") falseCritical.push(v.event);
  }

  const criticalVision = visionCounts.critical_field + visionCounts.critical_action;
  const report: Omit<EvaluationReport, "checks" | "pass"> = {
    counts: { dom: domCounts, vision: visionCounts },
    criticalFieldChangeRecall: ratio(domHits.critical_field, domCounts.critical_field),
    criticalActionRecall: ratio(domHits.critical_action, domCounts.critical_action),
    falseCriticalRate: ratio(falseCritical.length, criticalVision),
    nonCritical: (() => {
      const precision = ratio(visionHits.non_critical, visionCounts.non_critical);
      const recall = ratio(domHits.non_critical, domCounts.non_critical);
      const p = precision.value;
      const r = recall.value;
      return { precision, recall, f1: p === null || r === null ? null : p + r === 0 ? 0 : (2 * p * r) / (p + r) };
    })(),
    latency: { frameToEventMs: summary(input.frameToEventMs), changeToEventMs: summary(changeToEvent) },
    missedCritical,
    falseCritical,
  };
  const checks = [
    check("critical field-change recall", report.criticalFieldChangeRecall.value, ">=", P2_THRESHOLDS.criticalFieldChangeRecall),
    check("critical action recall", report.criticalActionRecall.value, ">=", P2_THRESHOLDS.criticalActionRecall),
    check("false critical rate", report.falseCriticalRate.value, "<=", P2_THRESHOLDS.falseCriticalRate),
    check("p95 frame→event (ms)", report.latency.frameToEventMs.p95, "<=", P2_THRESHOLDS.p95FrameToEventMs),
  ];
  return { ...report, checks, pass: checks.every((c) => c.pass) };
}

const fmt = (v: number | null, digits = 3): string => (v === null ? "n/a" : Number.isInteger(v) ? String(v) : v.toFixed(digits));
const fmtRatio = (r: Ratio): string => `${fmt(r.value)} (${r.numerator}/${r.denominator})`;

/** Human-readable table: every thresholded metric with PASS/FAIL, then the reported-only ones. */
export function formatReport(report: EvaluationReport): string {
  const rows: Array<[string, string, string, string]> = [
    ["metric", "value", "threshold", "result"],
    ...report.checks.map((c): [string, string, string, string] => {
      const ratioFor: Record<string, Ratio | undefined> = {
        "critical field-change recall": report.criticalFieldChangeRecall,
        "critical action recall": report.criticalActionRecall,
        "false critical rate": report.falseCriticalRate,
      };
      const r = ratioFor[c.metric];
      return [c.metric, r ? fmtRatio(r) : fmt(c.value, 0), `${c.comparator} ${c.threshold}`, c.pass ? "PASS" : "FAIL"];
    }),
    ["non-critical precision", fmtRatio(report.nonCritical.precision), "(reported)", ""],
    ["non-critical recall", fmtRatio(report.nonCritical.recall), "(reported)", ""],
    ["non-critical F1", fmt(report.nonCritical.f1), "(reported)", ""],
    ["p50 frame→event (ms)", fmt(report.latency.frameToEventMs.p50, 0), `(n=${report.latency.frameToEventMs.n})`, ""],
    ["p50 change→event (ms)", fmt(report.latency.changeToEventMs.p50, 0), "(reported)", ""],
    ["p95 change→event (ms)", fmt(report.latency.changeToEventMs.p95, 0), "(reported)", ""],
  ];
  const widths = [0, 1, 2, 3].map((i) => Math.max(...rows.map((r) => r[i]?.length ?? 0)));
  const line = (r: readonly string[]): string => r.map((cell, i) => cell.padEnd(widths[i] ?? 0)).join("  ").trimEnd();
  const c = report.counts;
  return [
    line(rows[0] ?? []),
    widths.map((w) => "-".repeat(w)).join("  "),
    ...rows.slice(1).map(line),
    "",
    `DOM events: ${c.dom.critical_field} critical field changes, ${c.dom.critical_action} critical actions, ${c.dom.non_critical} non-critical`,
    `Vision events: ${c.vision.critical_field} critical field changes, ${c.vision.critical_action} critical actions, ${c.vision.non_critical} non-critical`,
    `OVERALL: ${report.pass ? "PASS" : "FAIL"}`,
  ].join("\n");
}
