import { generateBenchCases, kycCases } from "@vashistha/core/domains/kyc";
import type { ExpertSettings, StrategyId } from "./config";
import { featuresOf } from "./domain";
import { SimulatedExpert, type TranscriptEntry } from "./expert";
import { absorb, EMPTY_KNOWLEDGE, fitPolicy, observe, type Knowledge } from "./learner";
import { behaviouralMetrics, labelHeldout, questionMetrics, rulesRecovered, type EquivalenceCache, type HeldoutCase, type Metrics } from "./metrics";
import { actaTemplates } from "./strategies/acta";
import { genericWhy } from "./strategies/generic-why";
import { ours } from "./strategies/ours";
import { recordOnly } from "./strategies/record-only";
import { Session, type Strategy, type StreamCase } from "./strategies/session";

export const STRATEGIES: Record<StrategyId, Strategy> = { A: recordOnly, B: genericWhy, C: actaTemplates, D: ours };

export type EpisodeSpec = {
  strategy: StrategyId;
  seed: number;
  budgets: readonly number[];
  trainingSize: number;
  heldoutSize: number;
  expert: ExpertSettings;
  thetaAsk: number;
};

export type EpisodeData = { stream: StreamCase[]; heldout: HeldoutCase[] };

/**
 * The cases of an episode: the first 3 demo training cases (the core demo; the judgment cases after them exercise
 * features the bench generator leaves neutral, so they stay out of the stream), then `trainingSize − 3` stratified bench
 * cases (seeded), then `heldoutSize` further cases of the same seeded sequence as the held-out set
 * (ids NS-2026-4000 upwards, so disjoint from the stream). Same seed ⇒ same cases for every strategy.
 */
export function episodeData(seed: number, trainingSize: number, heldoutSize: number): EpisodeData {
  const generated = generateBenchCases(seed, trainingSize - 3 + heldoutSize).map((c) => ({ caseId: c.id, features: featuresOf(c) }));
  const demo = kycCases("training").slice(0, 3).map((c) => ({ caseId: c.id, features: featuresOf(c) }));
  return { stream: [...demo, ...generated.slice(0, trainingSize - 3)], heldout: labelHeldout(generated.slice(trainingSize - 3)) };
}

export type EpisodeRun = { decisions: Knowledge; transcript: readonly TranscriptEntry[] };

/** Runs the strategy once with the largest budget; the expert channel records every question. */
export async function runStrategy(spec: EpisodeSpec, data: EpisodeData): Promise<EpisodeRun> {
  const expert = new SimulatedExpert({ settings: spec.expert, budget: Math.max(...spec.budgets), seed: spec.seed });
  const session = new Session(expert, data.stream, spec.thetaAsk);
  await STRATEGIES[spec.strategy](session);
  const decisions = data.stream.reduce<Knowledge>((k, c, i) => {
    const action = session.decisions[i];
    if (action === undefined) throw new Error(`strategy ${spec.strategy} skipped stream case ${i}`);
    return observe(k, c.caseId, c.features, action);
  }, EMPTY_KNOWLEDGE);
  return { decisions, transcript: expert.transcript };
}

/**
 * The learner's knowledge after the first `budget` questions: every observed decision, then the
 * answers in the order they were given. Strategies never see the budget, so a run with budget b asks
 * exactly the first b questions of a run with a larger one (tested); one run serves every budget.
 */
export function knowledgeAt(run: EpisodeRun, budget: number): Knowledge {
  return run.transcript.slice(0, budget).reduce((k, e) => absorb(k, e.question, e.answer), run.decisions);
}

export type BudgetResult = { budget: number; metrics: Metrics };

export async function runEpisode(spec: EpisodeSpec, cache: EquivalenceCache): Promise<BudgetResult[]> {
  const data = episodeData(spec.seed, spec.trainingSize, spec.heldoutSize);
  const run = await runStrategy(spec, data);
  const out: BudgetResult[] = [];
  for (const budget of spec.budgets) {
    const policy = fitPolicy(knowledgeAt(run, budget));
    out.push({
      budget,
      metrics: {
        ...behaviouralMetrics(policy, data.heldout),
        rulesRecovered: await rulesRecovered(policy, cache),
        ...questionMetrics(run.transcript.slice(0, budget)),
        statedRules: policy.stated.length,
        inducedRules: policy.induced.length,
      },
    });
  }
  return out;
}
