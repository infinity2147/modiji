/**
 * GC-pause and CPU-throttle telemetry on `/api/health/deep` (response-path hardening, bug 4): ops uses
 * these to tell a host/GC freeze (PROGRESS.md "Production stall diagnosis") from a code stall. The
 * readers must be cheap and must never throw — null when a signal is not available on this host.
 */
import { describe, expect, it } from "vitest";
import { createGcMonitor, readCpuThrottle } from "../../lib/server/event-loop";

describe("createGcMonitor", () => {
  it("reports non-negative pause stats and a monotonic window, and closes cleanly", async () => {
    const monitor = createGcMonitor();
    try {
      // Allocate and release some garbage so a collection is plausible; the observer is async, so yield.
      for (let i = 0; i < 50; i++) void new Array(10_000).fill(i);
      await new Promise((resolve) => setImmediate(resolve));
      const first = monitor.snapshot();
      expect(first.count).toBeGreaterThanOrEqual(0);
      expect(first.totalPauseMs).toBeGreaterThanOrEqual(0);
      expect(first.maxPauseMs).toBeGreaterThanOrEqual(0);
      expect(first.maxPauseMs).toBeLessThanOrEqual(first.totalPauseMs + 1e-9);
      await new Promise((resolve) => setTimeout(resolve, 5));
      expect(monitor.snapshot().sinceMs).toBeGreaterThanOrEqual(first.sinceMs);
    } finally {
      monitor.close();
    }
    expect(() => monitor.close()).not.toThrow(); // idempotent
  });
});

describe("readCpuThrottle", () => {
  it("returns null, or well-shaped non-negative counters, without throwing", () => {
    const throttle = readCpuThrottle();
    if (throttle === null) return; // no cgroup cpu.stat on this host (e.g. dev macOS)
    expect(throttle.nrPeriods).toBeGreaterThanOrEqual(0);
    expect(throttle.nrThrottled).toBeGreaterThanOrEqual(0);
    expect(throttle.throttledMs).toBeGreaterThanOrEqual(0);
    expect(Number.isInteger(throttle.throttledMs)).toBe(true);
  });
});
