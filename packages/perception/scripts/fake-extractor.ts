/**
 * Deterministic stand-in for the Haiku extractor, used ONLY to prove the evaluation harness end to
 * end without an API key. It reads the fixture's DOM ground truth (never pixels) and answers in the
 * model's structured-output shape with seeded noise — missed events, spurious critical field
 * changes, varied confidence and simulated latency on the injected clock. It is generous: each
 * frame reports every DOM event since its previous frame, including intermediate states a real
 * model could not see once frames were coalesced. Its scores say nothing about vision accuracy.
 */
import type { DomainConfig, ScreenEvent, Value } from "@vashistha/core";
import { mulberry32 } from "@vashistha/core/domains/kyc";
import type { FrameOutput } from "../src/extraction";
import type { Clock, FrameExtractor } from "../src/replay";

export type FakeNoise = {
  /** Probability each ground-truth event is omitted. */
  missRate: number;
  /** Probability per frame (with a case open) of an invented critical field change. */
  spuriousRate: number;
  latency: { baseMs: number; jitterMs: number; slowRate: number; slowMs: number };
};

export const DEFAULT_FAKE_NOISE: FakeNoise = {
  missRate: 0.05,
  spuriousRate: 0.03,
  latency: { baseMs: 700, jitterMs: 800, slowRate: 0.05, slowMs: 1500 },
};

export function createFakeExtractor(options: {
  domain: DomainConfig;
  domEvents: readonly ScreenEvent[];
  clock: Clock;
  seed: number;
  noise?: FakeNoise;
}): FrameExtractor {
  const { domain, clock } = options;
  const noise = options.noise ?? DEFAULT_FAKE_NOISE;
  const rng = mulberry32(options.seed);
  const dom = [...options.domEvents].sort((a, b) => a.captureTime - b.captureTime);
  const critical = new Set<string>(domain.criticalFields);
  const spuriousTargets = domain.features.flatMap((f) => (f.type === "enum" && critical.has(f.id) ? [f] : []));
  const valuesByCase = new Map<string, Map<string, Value>>();
  let caseId: string | null = null;
  let covered = Number.NEGATIVE_INFINITY;

  return async (input) => {
    const { latency } = noise;
    const delay = latency.baseMs + rng() * latency.jitterMs + (rng() < latency.slowRate ? latency.slowMs : 0);
    await clock.sleepUntil(clock.now() + delay);

    const events: FrameOutput["events"] = [];
    for (const e of dom) {
      if (e.captureTime <= covered || e.captureTime > input.captureTime) continue;
      if (e.kind === "open_case") caseId = e.caseId ?? null;
      if (e.kind === "navigate") caseId = null;
      if (e.kind === "field_change" && e.caseId !== undefined && e.field !== undefined && e.to !== undefined) {
        const values = valuesByCase.get(e.caseId) ?? new Map<string, Value>();
        values.set(e.field, e.to);
        valuesByCase.set(e.caseId, values);
      }
      if (rng() < noise.missRate) continue;
      events.push({
        kind: e.kind,
        caseId: e.caseId ?? null,
        field: e.field ?? null,
        from: e.from ?? null,
        to: e.to ?? null,
        action: e.action ?? null,
        confidence: Math.round((0.7 + 0.3 * rng()) * 100) / 100,
      });
    }
    covered = input.captureTime;

    const target = spuriousTargets[Math.floor(rng() * spuriousTargets.length)];
    if (caseId !== null && target !== undefined && rng() < noise.spuriousRate) {
      const to = target.values[Math.floor(rng() * target.values.length)] ?? null;
      events.push({ kind: "field_change", caseId, field: target.id, from: null, to, action: null, confidence: 0.6 });
    }

    const values = caseId === null ? [] : [...(valuesByCase.get(caseId) ?? new Map<string, Value>())];
    return {
      screen: { caseId, values: values.map(([field, value]) => ({ field, value })) },
      events,
      proposedConcepts: [],
    };
  };
}
