/**
 * Event-loop delay of this process since boot (`perf_hooks.monitorEventLoopDelay`), reported by
 * `GET /api/health/deep`: how long a timer due now waits for the loop. Every request handler — the
 * custom LLM and the gate included — waits at least that long, so preflight fails a target whose p99
 * is high (scripts/preflight/checks/server.ts).
 */
import { readFileSync } from "node:fs";
import { PerformanceObserver, monitorEventLoopDelay } from "node:perf_hooks";

/** Sampling interval. The histogram records intervals between samples; the interval itself is not delay. */
const RESOLUTION_MS = 10;
const NS_PER_MS = 1e6;

const round1 = (ms: number): number => Math.round(ms * 10) / 10;

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

/**
 * Garbage-collection pauses since boot (`perf_hooks` GC performance entries), reported by
 * `GET /api/health/deep`. A long GC pause stalls every request handler exactly as the event loop
 * does, so a high `maxPauseMs` with a healthy event-loop p99 points at GC (or a host freeze), not an
 * algorithmic stall (PROGRESS.md "Production stall diagnosis").
 */
export type GcStats = { count: number; totalPauseMs: number; maxPauseMs: number; sinceMs: number };
export type GcMonitor = { snapshot: () => GcStats; close: () => void };

export function createGcMonitor(): GcMonitor {
  const started = performance.now();
  let count = 0;
  let totalPauseMs = 0;
  let maxPauseMs = 0;
  const observer = new PerformanceObserver((list) => {
    for (const entry of list.getEntries()) {
      count += 1;
      totalPauseMs += entry.duration;
      if (entry.duration > maxPauseMs) maxPauseMs = entry.duration;
    }
  });
  // 'gc' is unavailable on some builds; without it the stats simply stay zero.
  try {
    observer.observe({ type: "gc", buffered: true });
  } catch {
    /* no GC entries: snapshot reports zeros */
  }
  return {
    snapshot: () => ({ count, totalPauseMs: round1(totalPauseMs), maxPauseMs: round1(maxPauseMs), sinceMs: Math.round(performance.now() - started) }),
    close: () => observer.disconnect(),
  };
}

/** CFS CPU-throttling counters, when the process runs under a cgroup that exposes them; else null. */
export type CpuThrottle = { nrPeriods: number; nrThrottled: number; throttledMs: number };

/** cgroup v2 first, then the common v1 mount points. */
const CPU_STAT_PATHS = ["/sys/fs/cgroup/cpu.stat", "/sys/fs/cgroup/cpu,cpuacct/cpu.stat", "/sys/fs/cgroup/cpuacct/cpu.stat"] as const;

/**
 * Reads the container's CPU-throttle counters (`cpu.stat`): how many CFS periods the scheduler
 * throttled this cgroup and for how long. A rising `nrThrottled` is the signature of the host
 * CPU-quota freeze in PROGRESS.md. Returns null when no cgroup `cpu.stat` is readable (e.g. local
 * macOS/dev), so callers report it as "unknown", never as healthy. Cheap: one small synchronous read.
 */
export function readCpuThrottle(): CpuThrottle | null {
  for (const path of CPU_STAT_PATHS) {
    let text: string;
    try {
      text = readFileSync(path, "utf8");
    } catch {
      continue;
    }
    const fields = new Map<string, number>();
    for (const line of text.split("\n")) {
      const [key, value] = line.trim().split(/\s+/);
      if (key !== undefined && value !== undefined && /^\d+$/.test(value)) fields.set(key, Number(value));
    }
    const nrThrottled = fields.get("nr_throttled");
    if (nrThrottled === undefined) continue;
    // cgroup v2 reports throttled_usec (microseconds); v1 reports throttled_time (nanoseconds).
    const usec = fields.get("throttled_usec");
    const nsec = fields.get("throttled_time");
    const throttledMs = usec !== undefined ? usec / 1000 : nsec !== undefined ? nsec / NS_PER_MS : 0;
    return { nrPeriods: fields.get("nr_periods") ?? 0, nrThrottled, throttledMs: Math.round(throttledMs) };
  }
  return null;
}
