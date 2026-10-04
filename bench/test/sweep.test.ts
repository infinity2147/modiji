import { FeatureIdSchema } from "@vashistha/core";
import { describe, expect, it } from "vitest";
import { renderChart } from "../src/chart";
import { benchConfig, QUICK_CONFIG, STRATEGY_IDS, type StrategyId } from "../src/config";
import { episodeData, runStrategy, type EpisodeSpec } from "../src/episode";
import { DOMAIN } from "../src/domain";
import { perturb } from "../src/strategies/acta";
import { runBench, type BenchResults } from "../src/sweep";

const SMALL = benchConfig({
  ...QUICK_CONFIG,
  seeds: [21, 22],
  budgets: [0, 3, 10],
  trainingSize: 14,
  heldoutSize: 120,
  robustness: [{ budget: 3, expert: { noise: 0.1, vagueness: 0.5 } }],
  parallelism: 1,
});

let first: Promise<BenchResults> | undefined;
const results = (): Promise<BenchResults> => (first ??= runBench(SMALL));

function spec(strategy: StrategyId, budget: number): EpisodeSpec {
  return { strategy, seed: 21, budgets: [budget], trainingSize: SMALL.trainingSize, heldoutSize: 20, expert: SMALL.expert, thetaAsk: SMALL.thetaAsk };
}

describe("sweep", () => {
  it("is deterministic: the same config gives an identical results JSON", async () => {
    const a = JSON.stringify(await results());
    const b = JSON.stringify(await runBench(SMALL));
    expect(b).toBe(a);
  });

  it("accounts budget identically: one unit per question, never more than the budget, and a smaller budget asks a prefix", async () => {
    const data = episodeData(21, SMALL.trainingSize, 20);
    for (const strategy of STRATEGY_IDS) {
      const long = await runStrategy(spec(strategy, 10), data);
      expect(long.transcript.length).toBeLessThanOrEqual(10);
      for (const b of [0, 1, 4]) {
        const short = await runStrategy(spec(strategy, b), data);
        expect(short.transcript, `${strategy} at budget ${b}`).toEqual(long.transcript.slice(0, b));
        expect(short.decisions).toEqual(long.decisions);
      }
    }
    for (const row of (await results()).rows) expect(row.metrics.questions).toBeLessThanOrEqual(row.budget);
  });

  it("A with 0 questions is the floor: at budget 0 everyone is A; with questions nobody is worse on fidelity or unsafe errors at the top budget", async () => {
    const r = await results();
    const at = (s: StrategyId, b: number) => r.main.find((a) => a.strategy === s && a.budget === b);
    const floor = at("A", 0);
    for (const s of STRATEGY_IDS) {
      expect(at(s, 0)?.mean).toEqual(floor?.mean);
      expect(at(s, 0)?.mean.questions).toBe(0);
    }
    for (const s of ["B", "C", "D"] as const) {
      expect(at(s, 10)?.mean.fidelity).toBeGreaterThan(floor?.mean.fidelity ?? 1);
      expect(at(s, 10)?.mean.unsafeFnRate).toBeLessThanOrEqual(floor?.mean.unsafeFnRate ?? 0);
    }
    expect(at("A", 10)?.mean).toEqual(floor?.mean);
  });

  it("renders a well-formed SVG with a series for every strategy", async () => {
    const svg = renderChart((await results()).main, { title: "Unsafe <rate> & questions", subtitle: "test", yLabel: "y", metric: "unsafeFnRate", percent: true });
    expect(svg.startsWith('<?xml version="1.0" encoding="UTF-8"?>\n<svg xmlns="http://www.w3.org/2000/svg"')).toBe(true);
    expect(isWellFormed(svg)).toBe(true);
    for (const s of STRATEGY_IDS) expect(svg).toContain(`data-strategy="${s}"`);
    expect(svg).toContain("Unsafe &lt;rate&gt; &amp; questions");
    expect(isWellFormed("<svg><g></svg></g>")).toBe(false);
  });

  it("ACTA's fixed perturbation stays inside the valid domain", () => {
    // Pick a genuinely new customer from the stream so the test does not depend on how the demo
    // training cases happen to be designed (case 1 is an existing customer after the narrative redesign).
    const c = episodeData(21, 24, 1).stream.find((x) => x.features[FeatureIdSchema.parse("customerStatus")] === "new");
    if (c === undefined) throw new Error("no new-customer case in the stream");
    const age = DOMAIN.features.find((f) => f.id === "accountAgeMonths");
    const status = DOMAIN.features.find((f) => f.id === "customerStatus");
    const pep = DOMAIN.features.find((f) => f.id === "pep");
    if (age === undefined || status === undefined || pep === undefined) throw new Error("missing feature");
    expect(perturb(c.features, pep)?.[pep.id]).toBe(!c.features[pep.id]);
    // A new customer (0 months) cannot become "existing" with 0 months, nor gain history while "new".
    expect(c.features[FeatureIdSchema.parse("customerStatus")]).toBe("new");
    expect(perturb(c.features, status)).toBeUndefined();
    expect(perturb(c.features, age)).toBeUndefined();
  });
});

/** Minimal XML well-formedness: balanced, properly nested tags, quoted attributes, escaped text. */
function isWellFormed(xml: string): boolean {
  const body = xml.replace(/^<\?xml[^?]*\?>\s*/, "");
  const stack: string[] = [];
  const tag = /<(\/?)([a-zA-Z][\w:-]*)((?:\s+[\w:-]+="[^"<]*")*)\s*(\/?)>/g;
  let last = 0;
  for (let m = tag.exec(body); m !== null; m = tag.exec(body)) {
    if (/[<>]/.test(body.slice(last, m.index).replace(/&(amp|lt|gt|quot|#\d+);/g, ""))) return false;
    last = m.index + m[0].length;
    const [, close, name, , selfClose] = m;
    if (name === undefined) return false;
    if (close === "/") {
      if (stack.pop() !== name) return false;
    } else if (selfClose !== "/") stack.push(name);
  }
  return stack.length === 0 && !/[<>]/.test(body.slice(last));
}
