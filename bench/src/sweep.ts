import { Worker } from "node:worker_threads";
import { z } from "zod";
import { ExpertSettingsSchema, ReportedConfigSchema, STRATEGY_IDS, StrategyIdSchema, type BenchConfig, type ExpertSettings, type StrategyId } from "./config";
import { runEpisode, type BudgetResult, type EpisodeSpec } from "./episode";
import { BENCH_ENGINE_CONFIG } from "./learner";
import { METRIC_KEYS, MetricsSchema, SIMPLE_ORACLE_RULES, type Metrics } from "./metrics";
import { FAMILY_RULES } from "./oracle";

const BudgetResultSchema = z.strictObject({ budget: z.int().nonnegative(), metrics: MetricsSchema });
const EpisodeRowSchema = z.strictObject({ strategy: StrategyIdSchema, seed: z.int(), expert: ExpertSettingsSchema, budget: z.int(), metrics: MetricsSchema });
export type EpisodeRow = z.infer<typeof EpisodeRowSchema>;

const MetricNumbersSchema = z.strictObject(Object.fromEntries(METRIC_KEYS.map((k) => [k, z.number()])) as Record<keyof Metrics, z.ZodNumber>);
export type MetricNumbers = z.infer<typeof MetricNumbersSchema>;
const AggregateSchema = z.strictObject({
  strategy: StrategyIdSchema,
  budget: z.int(),
  expert: ExpertSettingsSchema,
  n: z.int().positive(),
  mean: MetricNumbersSchema,
  /** Sample standard deviation across seeds (0 for a single seed). */
  std: MetricNumbersSchema,
});
export type Aggregate = z.infer<typeof AggregateSchema>;

/** Everything a run produces that is a function of the config: no timings, no machine details. */
export const BenchResultsSchema = z.strictObject({
  benchmark: z.literal("Apprentice-Bench"),
  /** The expert is a deterministic simulation of NSRP-1, not a person (plan §9). */
  simulatedExpert: z.literal(true),
  config: ReportedConfigSchema,
  engine: z.strictObject({ lambda: z.number(), expertNoisePrior: z.number(), maxConditions: z.int(), maxCandidates: z.int(), roundThresholdsPerBoundary: z.int() }),
  oracle: z.strictObject({ policy: z.literal("NSRP-1"), family: z.string(), rules: z.int(), simpleRules: z.array(z.string()) }),
  rows: z.array(EpisodeRowSchema),
  main: z.array(AggregateSchema),
  robustness: z.array(AggregateSchema),
});
export type BenchResults = z.infer<typeof BenchResultsSchema>;

export type Job = { index: number; spec: EpisodeSpec };

/** Main grid (every strategy × seed over all budgets), then each robustness row (every strategy × seed at its budget). */
function jobs(config: BenchConfig): Job[] {
  const base = { trainingSize: config.trainingSize, heldoutSize: config.heldoutSize, thetaAsk: config.thetaAsk };
  const specs: EpisodeSpec[] = [];
  for (const strategy of STRATEGY_IDS)
    for (const seed of config.seeds) specs.push({ ...base, strategy, seed, budgets: config.budgets, expert: config.expert });
  for (const r of config.robustness)
    for (const strategy of STRATEGY_IDS) for (const seed of config.seeds) specs.push({ ...base, strategy, seed, budgets: [r.budget], expert: r.expert });
  return specs.map((spec, index) => ({ index, spec }));
}

export async function runBench(config: BenchConfig): Promise<BenchResults> {
  const all = jobs(config);
  const results = config.parallelism > 1 ? await runInWorkers(all, config.parallelism) : await runInProcess(all);
  const rows: EpisodeRow[] = all.flatMap((job) =>
    (results[job.index] ?? []).map((r) => ({ strategy: job.spec.strategy, seed: job.spec.seed, expert: job.spec.expert, budget: r.budget, metrics: r.metrics })),
  );
  const mainRows = rows.slice(0, STRATEGY_IDS.length * config.seeds.length * config.budgets.length);
  const robustRows = rows.slice(mainRows.length);
  const { parallelism: _parallelism, ...reported } = config;
  return BenchResultsSchema.parse({
    benchmark: "Apprentice-Bench",
    simulatedExpert: true,
    config: reported,
    engine: {
      lambda: BENCH_ENGINE_CONFIG.lambda,
      expertNoisePrior: BENCH_ENGINE_CONFIG.expertNoisePrior,
      maxConditions: BENCH_ENGINE_CONFIG.maxConditions,
      maxCandidates: BENCH_ENGINE_CONFIG.maxCandidates,
      roundThresholdsPerBoundary: BENCH_ENGINE_CONFIG.roundThresholdsPerBoundary,
    },
    oracle: { policy: "NSRP-1", family: "reviewOutcome", rules: FAMILY_RULES.length, simpleRules: SIMPLE_ORACLE_RULES.map((r) => r.id) },
    rows,
    main: aggregate(mainRows),
    robustness: aggregate(robustRows),
  });
}

async function runInProcess(all: readonly Job[]): Promise<BudgetResult[][]> {
  const cache = new Map<string, boolean>();
  const out: BudgetResult[][] = [];
  for (const job of all) out[job.index] = await runEpisode(job.spec, cache);
  return out;
}

const WorkerReplySchema = z.strictObject({ index: z.int(), results: z.array(BudgetResultSchema) });

/** A pool of worker threads (each with its own Z3), longest jobs (strategy D) first. Results are keyed by job index, so order never depends on timing. */
async function runInWorkers(all: readonly Job[], parallelism: number): Promise<BudgetResult[][]> {
  const queue = [...all].sort((a, b) => Number(b.spec.strategy === "D") - Number(a.spec.strategy === "D") || a.index - b.index);
  const out: BudgetResult[][] = [];
  const size = Math.min(parallelism, queue.length);
  await Promise.all(
    Array.from({ length: size }, async () => {
      const worker = new Worker(new URL("./worker.ts", import.meta.url));
      try {
        for (let job = queue.shift(); job !== undefined; job = queue.shift()) {
          const reply = await request(worker, job);
          out[reply.index] = reply.results;
        }
      } finally {
        await worker.terminate();
      }
    }),
  );
  return out;
}

function request(worker: Worker, job: Job): Promise<z.infer<typeof WorkerReplySchema>> {
  return new Promise((resolve, reject) => {
    const cleanup = (): void => {
      worker.off("message", onMessage);
      worker.off("error", onError);
    };
    const onMessage = (m: unknown): void => {
      cleanup();
      const parsed = WorkerReplySchema.safeParse(m);
      if (parsed.success) resolve(parsed.data);
      else reject(new Error(`bad worker reply for job ${job.index}: ${z.prettifyError(parsed.error)}`));
    };
    const onError = (e: Error): void => {
      cleanup();
      reject(e);
    };
    worker.on("message", onMessage);
    worker.on("error", onError);
    worker.postMessage(job);
  });
}

function aggregate(rows: readonly EpisodeRow[]): Aggregate[] {
  const groups = new Map<string, { strategy: StrategyId; budget: number; expert: ExpertSettings; rows: EpisodeRow[] }>();
  for (const r of rows) {
    const key = JSON.stringify([r.strategy, r.budget, r.expert.noise, r.expert.vagueness]);
    const g = groups.get(key) ?? { strategy: r.strategy, budget: r.budget, expert: r.expert, rows: [] };
    g.rows.push(r);
    groups.set(key, g);
  }
  return [...groups.values()].map((g) => {
    const stat = (f: (values: number[]) => number): MetricNumbers =>
      Object.fromEntries(METRIC_KEYS.map((k) => [k, f(g.rows.map((r) => r.metrics[k]))])) as MetricNumbers;
    return { strategy: g.strategy, budget: g.budget, expert: g.expert, n: g.rows.length, mean: stat(mean), std: stat(sampleStd) };
  });
}

function mean(xs: readonly number[]): number {
  return xs.reduce((s, x) => s + x, 0) / xs.length;
}

function sampleStd(xs: readonly number[]): number {
  if (xs.length < 2) return 0;
  const m = mean(xs);
  return Math.sqrt(xs.reduce((s, x) => s + (x - m) ** 2, 0) / (xs.length - 1));
}
