/**
 * `pnpm bench` — the default sweep; `pnpm bench --quick` — the CI preset. Writes results.json,
 * report.md and the SVG charts to bench/out/; a full run also copies them to docs/evidence/bench/.
 * Run with `node --conditions=react-server --import tsx` (the oracle module is `server-only`).
 */
import { copyFile, mkdir, writeFile } from "node:fs/promises";
import { parseArgs } from "node:util";
import { benchConfig, DEFAULT_CONFIG, QUICK_CONFIG } from "./config";
import { renderChart } from "./chart";
import { renderReport } from "./report";
import { runBench } from "./sweep";

const { values } = parseArgs({ options: { quick: { type: "boolean", default: false } } });
const quick = values.quick === true;
const config = benchConfig(quick ? QUICK_CONFIG : DEFAULT_CONFIG);
const outDir = new URL("../out/", import.meta.url);
const evidenceDir = new URL("../../docs/evidence/bench/", import.meta.url);

console.info(`Apprentice-Bench ${quick ? "(quick)" : "(full)"}: ${config.seeds.length} seeds × budgets [${config.budgets.join(", ")}] × 4 strategies, ${config.parallelism} workers`);
const started = performance.now();
const results = await runBench(config);
const wallSeconds = (performance.now() - started) / 1000;

const subtitle = `Simulated expert (NSRP-1 oracle) · mean ± 1 s.d. over ${config.seeds.length} seeds · ${config.heldoutSize} held-out cases`;
const files: Record<string, string> = {
  "results.json": `${JSON.stringify(results, null, 2)}\n`,
  "report.md": renderReport(results, { wallSeconds, command: quick ? "pnpm bench --quick" : "pnpm bench", parallelism: config.parallelism }),
  "unsafe-vs-questions.svg": renderChart(results.main, {
    title: "Unsafe error rate vs number of expert questions",
    subtitle,
    yLabel: "Unsafe FN rate (would approve; oracle does not)",
    metric: "unsafeFnRate",
    percent: true,
  }),
  "fidelity-vs-questions.svg": renderChart(results.main, {
    title: "Behavioural fidelity vs number of expert questions",
    subtitle,
    yLabel: "Fidelity (agreement with oracle)",
    metric: "fidelity",
    percent: false,
  }),
};
await mkdir(outDir, { recursive: true });
for (const [name, content] of Object.entries(files)) await writeFile(new URL(name, outDir), content);
if (!quick) {
  await mkdir(evidenceDir, { recursive: true });
  for (const name of Object.keys(files)) await copyFile(new URL(name, outDir), new URL(name, evidenceDir));
}
console.info(`done in ${wallSeconds.toFixed(1)} s → ${outDir.pathname}${quick ? "" : ` (copied to ${evidenceDir.pathname})`}`);
