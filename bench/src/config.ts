import { z } from "zod";

export const STRATEGY_IDS = ["A", "B", "C", "D"] as const;
export const StrategyIdSchema = z.enum(STRATEGY_IDS);
export type StrategyId = z.infer<typeof StrategyIdSchema>;

export const STRATEGY_LABELS: Record<StrategyId, string> = {
  A: "A · record-only",
  B: "B · generic why",
  C: "C · ACTA templates",
  D: "D · ours (surprise + EIG + Z3)",
};

/** How the simulated expert answers (plan §9). Both knobs default to a perfect, precise expert. */
export const ExpertSettingsSchema = z.strictObject({
  /** Probability that a decision or counterfactual answer is replaced by a uniformly drawn other action of the family. */
  noise: z.number().min(0).max(1).default(0),
  /** Probability that a stated rule is verbalised vaguely (a dropped conjunct or a threshold off by ±20 %). */
  vagueness: z.number().min(0).max(1).default(0),
});
export type ExpertSettings = z.output<typeof ExpertSettingsSchema>;

/**
 * One bench run. Every number in the results is a deterministic function of this object: cases,
 * expert noise and vagueness all derive from `seeds`.
 */
const BenchConfigObject = z.strictObject({
    seeds: z.array(z.int().nonnegative()).min(1),
    /** Question budgets B per episode; the same for every strategy. */
    budgets: z.array(z.int().nonnegative()).min(1),
    /** Observed expert decisions per episode (the 3 demo training cases first). */
    trainingSize: z.int().min(3).max(200),
    /** Held-out cases per episode (valid, disjoint ids from the training stream). */
    heldoutSize: z.int().min(1).max(5000),
    expert: ExpertSettingsSchema,
    /** Robustness rows: each re-runs every strategy at `budget` with these expert settings. */
    robustness: z.array(z.strictObject({ budget: z.int().nonnegative(), expert: ExpertSettingsSchema })),
    /** Strategy D asks a live question when its best question's value reaches θ (bits), or on a contradiction. */
    thetaAsk: z.number().nonnegative(),
    /** Worker threads for the sweep (1 = in-process). Never changes results. */
    parallelism: z.int().min(1).max(64),
});
/** The configuration as reported in results.json: everything except `parallelism`, which never changes results. */
export const ReportedConfigSchema = BenchConfigObject.omit({ parallelism: true });
export const BenchConfigSchema = BenchConfigObject.refine((c) => c.trainingSize + c.heldoutSize - 3 <= 6000, { message: "trainingSize + heldoutSize - 3 must be ≤ 6000 (bench id range)" });
export type BenchConfig = z.output<typeof BenchConfigSchema>;
export type BenchConfigInput = z.input<typeof BenchConfigSchema>;

const PRECISE_EXPERT = { noise: 0, vagueness: 0 };

export const DEFAULT_CONFIG: BenchConfigInput = {
  seeds: [1001, 1002, 1003, 1004, 1005],
  budgets: [0, 2, 4, 6, 8, 12, 16, 24],
  trainingSize: 24,
  heldoutSize: 500,
  expert: PRECISE_EXPERT,
  robustness: [
    { budget: 12, expert: { noise: 0, vagueness: 0.25 } },
    { budget: 12, expert: { noise: 0, vagueness: 0.5 } },
    { budget: 12, expert: { noise: 0.1, vagueness: 0 } },
  ],
  thetaAsk: 0.5,
  parallelism: 24,
};

/** CI preset: the same method on a smaller grid. */
export const QUICK_CONFIG: BenchConfigInput = {
  ...DEFAULT_CONFIG,
  seeds: [1001, 1002],
  budgets: [0, 4, 12],
  heldoutSize: 150,
  robustness: [{ budget: 4, expert: { noise: 0, vagueness: 0.5 } }],
};

export function benchConfig(input: BenchConfigInput): BenchConfig {
  return BenchConfigSchema.parse(input);
}
