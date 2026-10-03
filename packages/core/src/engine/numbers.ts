import type { Feature } from "../schemas/domain";

export type NumberFeature = Extract<Feature, { type: "number" }>;

/**
 * Round steps for a numeric feature, coarsest first. "meaningful" steps are what an expert would
 * plausibly use as a policy threshold (multiples of 25/10/5 for %, of 12 for months, 1-2-5 round
 * values for money and other quantities); "fine" continues to steps that still read naturally in a
 * counterfactual question ("26%", "18 months").
 */
export function roundSteps(f: NumberFeature, depth: "meaningful" | "fine"): number[] {
  const unit = f.unit?.trim().toLowerCase();
  if (unit === "%") return depth === "meaningful" ? [25, 10, 5] : [25, 10, 5, 1, 0.5, 0.1];
  if (unit === "months" || unit === "month") return depth === "meaningful" ? [12] : [12, 6, 3, 1];
  const range = f.max - f.min;
  if (!(range > 0)) return [];
  // 1-2-5 series down to 1/1000 (meaningful) or 1/10^6 (fine) of the range; integer features stop at 1.
  const smallest = Math.max(range / (depth === "meaningful" ? 1e3 : 1e6), f.integer ? 1 : 0);
  const steps: number[] = [];
  for (let e = Math.floor(Math.log10(range)); ; e--) {
    for (const s of [10 ** e, 5 * 10 ** (e - 1), 2 * 10 ** (e - 1)]) {
      const step = tidy(s);
      if (step < smallest) return steps;
      steps.push(step);
    }
  }
}

/** True when `t` is a multiple of one of the feature's meaningful steps (0 included). */
export function isMeaningfulRound(f: NumberFeature, t: number): boolean {
  return roundSteps(f, "meaningful").some((step) => Math.abs(t / step - Math.round(t / step)) < 1e-9);
}

/**
 * Up to `count` meaningful round numbers in the closed interval [lo, hi] (clipped to the feature's
 * bounds): coarser steps first, then closest to the interval's midpoint, then smaller.
 */
export function meaningfulRoundsIn(f: NumberFeature, lo: number, hi: number, count: number): number[] {
  const a = Math.max(lo, f.min);
  const b = Math.min(hi, f.max);
  const found: number[] = [];
  for (const step of roundSteps(f, "meaningful")) {
    for (const v of nearestMultiples(a, b, step, count)) {
      if (found.length >= count) return found;
      if (!found.includes(v)) found.push(v);
    }
  }
  return found;
}

/**
 * The roundest value strictly between lo and hi (within the feature's bounds), closest to the
 * midpoint; the midpoint itself when no fine step fits (non-integer features only). Undefined when
 * the open interval holds no admissible value (e.g. adjacent integers).
 */
export function roundestBetween(f: NumberFeature, lo: number, hi: number): number | undefined {
  const a = Math.max(lo, f.min);
  const b = Math.min(hi, f.max);
  if (!(a < b)) return undefined;
  for (const step of roundSteps(f, "fine")) {
    const inside = nearestMultiples(a, b, step, 3).filter((v) => v > lo && v < hi);
    if (inside[0] !== undefined) return inside[0];
  }
  if (f.integer) return undefined;
  const mid = tidy((a + b) / 2);
  return mid > lo && mid < hi ? mid : undefined;
}

/** Multiples of `step` in [lo, hi], closest to the midpoint first (ties: smaller first). */
function nearestMultiples(lo: number, hi: number, step: number, count: number): number[] {
  const first = Math.ceil(lo / step - 1e-9);
  const last = Math.floor(hi / step + 1e-9);
  if (first > last) return [];
  const centre = Math.min(last, Math.max(first, Math.round((lo + hi) / 2 / step)));
  const out: number[] = [centre];
  // Expand `count` steps each way (rounding can put the centre off-midpoint), then rank exactly.
  for (let d = 1; d <= count; d++) {
    if (centre - d >= first) out.push(centre - d);
    if (centre + d <= last) out.push(centre + d);
  }
  const mid = (lo + hi) / 2;
  return out
    .map((i) => tidy(i * step))
    .sort((x, y) => Math.abs(x - mid) - Math.abs(y - mid) || x - y)
    .slice(0, count);
}

/** Removes binary floating-point noise (3 × 0.1 → 0.3). */
export function tidy(x: number): number {
  return Number(x.toPrecision(12));
}
