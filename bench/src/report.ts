import { STRATEGY_IDS, STRATEGY_LABELS, type StrategyId } from "./config";
import type { Aggregate, BenchResults, MetricNumbers } from "./sweep";

export type RunInfo = { wallSeconds: number; command: string; parallelism: number };

const pct = (x: number): string => `${(x * 100).toFixed(1)}%`;
const num = (x: number, digits = 2): string => x.toFixed(digits);

function cell(a: Aggregate | undefined, key: keyof MetricNumbers, fmt: (x: number) => string): string {
  if (a === undefined) return "—";
  return a.n > 1 ? `${fmt(a.mean[key])} ± ${fmt(a.std[key])}` : fmt(a.mean[key]);
}

function find(list: readonly Aggregate[], strategy: StrategyId, budget: number): Aggregate | undefined {
  return list.find((a) => a.strategy === strategy && a.budget === budget);
}

function mainTable(r: BenchResults): string {
  const head = "| Budget | Strategy | Fidelity | Unsafe FN rate | Guardrail recall | Rules recovered (of 7) | Questions (why / cf) | Interruptions |";
  const sep = "|---:|---|---:|---:|---:|---:|---:|---:|";
  const lines = r.config.budgets.flatMap((b) =>
    STRATEGY_IDS.map((s) => {
      const a = find(r.main, s, b);
      const q = a === undefined ? "—" : `${num(a.mean.questions, 1)} (${num(a.mean.whyQuestions, 1)} / ${num(a.mean.counterfactualQuestions, 1)})`;
      return `| ${b} | ${STRATEGY_LABELS[s]} | ${cell(a, "fidelity", (x) => num(x, 3))} | ${cell(a, "unsafeFnRate", pct)} | ${cell(a, "guardrailRecall", pct)} | ${cell(a, "rulesRecovered", (x) => num(x, 1))} | ${q} | ${cell(a, "interruptions", (x) => num(x, 1))} |`;
    }),
  );
  return [head, sep, ...lines].join("\n");
}

function robustnessTable(r: BenchResults): string {
  if (r.config.robustness.length === 0) return "_No robustness rows configured._";
  const head = "| Budget | Expert | Strategy | Fidelity | Unsafe FN rate | Rules recovered | Questions |";
  const sep = "|---:|---|---|---:|---:|---:|---:|";
  const lines = r.config.robustness.flatMap((row) =>
    STRATEGY_IDS.map((s) => {
      const a = r.robustness.find((x) => x.strategy === s && x.budget === row.budget && x.expert.noise === row.expert.noise && x.expert.vagueness === row.expert.vagueness);
      return `| ${row.budget} | noise ${row.expert.noise}, vagueness ${row.expert.vagueness} | ${STRATEGY_LABELS[s]} | ${cell(a, "fidelity", (x) => num(x, 3))} | ${cell(a, "unsafeFnRate", pct)} | ${cell(a, "rulesRecovered", (x) => num(x, 1))} | ${cell(a, "questions", (x) => num(x, 1))} |`;
    }),
  );
  return [head, sep, ...lines].join("\n");
}

/** Computed, not written: which strategy is best per budget, and where D wins or loses. */
function findings(r: BenchResults): string[] {
  const out: string[] = [];
  const budgets = r.config.budgets.filter((b) => b > 0);
  const best = (b: number, key: keyof MetricNumbers, lower: boolean): { ids: StrategyId[]; value: number } => {
    const vals = STRATEGY_IDS.flatMap((s) => {
      const a = find(r.main, s, b);
      return a === undefined ? [] : [{ s, v: a.mean[key] }];
    });
    const value = lower ? Math.min(...vals.map((x) => x.v)) : Math.max(...vals.map((x) => x.v));
    return { ids: vals.filter((x) => Math.abs(x.v - value) < 1e-9).map((x) => x.s), value };
  };
  const dSafest = budgets.filter((b) => best(b, "unsafeFnRate", true).ids.includes("D"));
  const dFaithful = budgets.filter((b) => best(b, "fidelity", false).ids.includes("D"));
  out.push(`D has the lowest (or tied lowest) mean unsafe FN rate at ${dSafest.length} of ${budgets.length} non-zero budgets${dSafest.length > 0 ? ` (budgets ${dSafest.join(", ")})` : ""}.`);
  out.push(`D has the highest (or tied highest) mean fidelity at ${dFaithful.length} of ${budgets.length} non-zero budgets${dFaithful.length > 0 ? ` (budgets ${dFaithful.join(", ")})` : ""}.`);
  for (const b of budgets) {
    const safe = best(b, "unsafeFnRate", true);
    const fid = best(b, "fidelity", false);
    const d = find(r.main, "D", b);
    out.push(
      `Budget ${b}: lowest unsafe FN ${pct(safe.value)} by ${safe.ids.join("/")}; highest fidelity ${num(fid.value, 3)} by ${fid.ids.join("/")}` +
        (d === undefined ? "." : `; D: unsafe FN ${pct(d.mean.unsafeFnRate)}, fidelity ${num(d.mean.fidelity, 3)}, ${num(d.mean.questions, 1)} questions asked, ${num(d.mean.interruptions, 1)} interruptions.`),
    );
  }
  const top = Math.max(...r.config.budgets);
  const dTop = find(r.main, "D", top);
  if (dTop !== undefined && dTop.mean.questions < top)
    out.push(`At budget ${top}, D stopped early: ${num(dTop.mean.questions, 1)} questions on average (no unasked Z3 witness with EIG ≥ θ left: coverage closed under the learned rules).`);
  const seedsWithUnsafe = STRATEGY_IDS.map((s) => {
    const n = r.rows.filter((row) => row.strategy === s && row.budget === top && row.metrics.unsafeFnRate > 0).length;
    return `${s} ${n}/${r.config.seeds.length}`;
  });
  out.push(`Seeds with any unsafe approval at budget ${top}: ${seedsWithUnsafe.join(", ")} (the means above average over seeds; one bad seed moves them).`);
  const floor = find(r.main, "A", 0);
  if (floor !== undefined) {
    out.push(`Floor (A, no questions): fidelity ${num(floor.mean.fidelity, 3)}, unsafe FN ${pct(floor.mean.unsafeFnRate)}, guardrail recall ${pct(floor.mean.guardrailRecall)}.`);
    const worse = r.main.filter(
      (a) => a.strategy !== "A" && (a.mean.guardrailRecall < floor.mean.guardrailRecall - 1e-9 || a.mean.unsafeFnRate > floor.mean.unsafeFnRate + 1e-9),
    );
    if (worse.length > 0)
      out.push(
        `Worse than the floor on a safety metric: ${worse.map((a) => `${a.strategy} at budget ${a.budget} (guardrail recall ${pct(a.mean.guardrailRecall)}, unsafe FN ${pct(a.mean.unsafeFnRate)})`).join("; ")}.`,
      );
  }
  return out;
}

export function renderReport(r: BenchResults, run: RunInfo): string {
  const c = r.config;
  return `# Apprentice-Bench results

> **Simulation disclaimer.** The "expert" in this benchmark is a deterministic program that answers
> from NSRP-1, a fictional hidden policy for a fictional bank (plan §9). No person was asked anything;
> no number here is a human-subject result. Human testers, if any, are reported separately as an
> internal demonstration, not a powered learning study.

Generated by \`${run.command}\` in **${run.wallSeconds.toFixed(1)} s** wall time (${run.parallelism} worker threads).
Every number below is a deterministic function of the configuration in \`results.json\` (seeds ${c.seeds.join(", ")}):
re-running produces an identical \`results.json\`.

![Unsafe error rate vs expert questions](unsafe-vs-questions.svg)

![Behavioural fidelity vs expert questions](fidelity-vs-questions.svg)

## Findings (computed from the table)

${findings(r)
  .map((l) => `- ${l}`)
  .join("\n")}

## Main results (precise expert: noise ${c.expert.noise}, vagueness ${c.expert.vagueness})

Mean ± sample standard deviation over ${c.seeds.length} seeds; ${c.trainingSize} observed decisions and ${c.heldoutSize} held-out cases per episode.

${mainTable(r)}

## Robustness (imperfect expert)

${robustnessTable(r)}

## Method

- **Oracle (only ground truth).** NSRP-1 (\`@vashistha/core/domains/kyc/oracle\`): ${r.oracle.rules} rules in the \`${r.oracle.family}\` family with priorities, one exception (override) and two guardrails; default action \`approve\`. Only the simulated expert and the metrics read it; a test fails if the learner or a strategy imports it.
- **Simulated expert.** Counterfactual questions are answered by evaluating the oracle on the asked case. Why-questions (only about a case the expert decided) return the decisive rule(s), the firing guardrails and, for an exception, the rule it overrides — as stated rules with predicate, effect, precedence and opaque rule ids; never any other rule. Optional noise replaces an action with a random other one; optional vagueness drops a conjunct or moves a threshold by ±20 % in a statement. Seeded; no LLM.
- **Episode.** The 3 demo training cases, then ${c.trainingSize - 3} stratified generated cases (\`generateBenchCases\`, seeded), observed with the expert's decision; ${c.heldoutSize} further cases of the same seeded sequence are the held-out set (disjoint ids). Every strategy sees the same cases for a seed.
- **Budget.** Every question costs one unit, whatever its kind. Strategies do not see the budget: they ask until the channel refuses, so the run with budget b asks exactly the first b questions of the largest-budget run (tested), and one run per strategy and seed serves all budgets.
- **Learner (shared).** Stated rules are promoted with the engine's \`promoteToConfirmedRule\` (synthetic, bench-only evidence) at their stated priority. Observations no stated rule decides are explained by induced rules: the engine's \`enumerateCandidates\` hypothesis space (λ = ${r.engine.lambda}, ε = ${r.engine.expertNoisePrior}, ≤ ${r.engine.maxConditions} conditions, ${r.engine.maxCandidates} simplest candidates, ${r.engine.roundThresholdsPerBoundary} round threshold per boundary) turned into a decision list by ordered covering on log-posterior gain. Decisions use the solver's \`effectiveDecision\` (priorities, overrides); unresolved cases fall back to the stated default, else the most frequent action among uncovered observations, else the most frequent observed action. Guardrails use \`checkAction\`.
- **Strategies.** A record-only. B a why-question after every decision until the budget ends. C ACTA templates: a why-probe on the first occurrence of each action, then fixed one-feature perturbation counterfactuals. D ours: at most one live question per decision, only on a contradiction (surprise ≥ 3 bits, or a stated rule predicting wrongly) or when the engine's best question (EIG-valued counterfactual or why-probe) reaches θ = ${c.thetaAsk} bits; then a debrief of Z3 witnesses (unresolved, conflict, boundary) over the current learned rulebook ranked by EIG, with a why-question when an answer contradicts the learned policy; it stops when no unasked witness reaches θ (so it may leave budget unspent).

### Metric definitions

- **Fidelity:** share of held-out cases where the learned \`reviewOutcome\` equals the oracle's.
- **Unsafe FN rate (headline):** among held-out cases the oracle does not approve, the share the learned policy would approve (predicts \`approve\` and its own guardrails allow it).
- **Guardrail recall:** among held-out cases where an oracle guardrail constrains approving (sanctions forbid it; a PEP requires sign-off), the share where the learned policy also blocks approving (does not predict it, or its guardrails do not allow it).
- **Rules recovered:** of the ${r.oracle.simpleRules.length} oracle rules with ≤ 2 conditions (${r.oracle.simpleRules.join(", ")}), how many have a learned rule with the same effect and a Z3-equivalent predicate over all valid cases.
- **Questions / interruptions:** questions asked; interruptions = live pauses (decisions after which at least one question was asked before the next case). Debrief questions interrupt nothing. A simulation metric: the bench has no clock.

## Caveats (read before quoting a number)

- One fictional policy, one domain, one decision family, ${c.seeds.length} seeds: these results show how the strategies behave on NSRP-1, not in general.
- At vagueness 0, a why-answer is the exact rule with its precedence: an upper bound on what a real expert's words give, and the reason why-heavy strategies (B) do well here. The robustness rows show what vague statements cost.
- The learner trusts stated rules over data (as the product trusts confirmed rules). A vague statement therefore stays wrong until restated, and a partial set of stated rules can outrank a correct induced rule (e.g. a stated exception that approves, above induced sanctions or PEP rules the expert has not stated yet), which is how a few questions can lower guardrail recall below the record-only floor.
- Z3 witnesses are relative to the conditions of the learned rules ("no unresolved counterexample under the current feature model"): a rule on a feature that no learned rule mentions cannot be found by the debrief; only observed decisions or questions about them reveal it.
- θ = 0.5 bits and the engine settings were fixed before the first sweep and are not tuned per seed. One design change followed a first sweep: D's debrief now also requires EIG ≥ θ (before, it spent its remaining budget on witnesses with zero expected information gain; its fidelity and unsafe rate were unchanged, it now asks fewer questions).
- The interruption count is a simulation proxy, not a measured user experience.
`;
}
