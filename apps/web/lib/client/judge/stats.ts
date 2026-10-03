/** Nearest-rank percentiles for the engineering view's latency readout. */
export type Percentiles = { p50: number; p95: number; n: number };

export function percentiles(samples: readonly number[]): Percentiles | null {
  if (samples.length === 0) return null;
  const sorted = [...samples].sort((a, b) => a - b);
  const rank = (p: number): number => sorted[Math.max(0, Math.ceil(p * sorted.length) - 1)] ?? Number.NaN;
  return { p50: rank(0.5), p95: rank(0.95), n: sorted.length };
}
