/**
 * Event-loop delay of this process since boot (`perf_hooks.monitorEventLoopDelay`), reported by
 * `GET /api/health/deep`: how long a timer due now waits for the loop. Every request handler — the
 * custom LLM and the gate included — waits at least that long, so preflight fails a target whose p99
 * is high (scripts/preflight/checks/server.ts).
 */
import { monitorEventLoopDelay } from "node:perf_hooks";

/** Sampling interval. The histogram records intervals between samples; the interval itself is not delay. */
const RESOLUTION_MS = 10;
const NS_PER_MS = 1e6;

export type EventLoopDelay = { p50Ms: number; p99Ms: number; maxMs: number; samples: number; sinceMs: number };
export type EventLoopMonitor = { snapshot: () => EventLoopDelay; close: () => void };

export function createEventLoopMonitor(): EventLoopMonitor {
  const started = performance.now();
  const histogram = monitorEventLoopDelay({ resolution: RESOLUTION_MS });
  histogram.enable();
  const delayMs = (ns: number): number => (histogram.count === 0 ? 0 : Math.round(Math.max(0, ns / NS_PER_MS - RESOLUTION_MS) * 10) / 10);
  return {
    snapshot: () => ({
      p50Ms: delayMs(histogram.percentile(50)),
      p99Ms: delayMs(histogram.percentile(99)),
      maxMs: delayMs(histogram.max),
      samples: histogram.count,
      sinceMs: Math.round(performance.now() - started),
    }),
    close: () => histogram.disable(),
  };
}
