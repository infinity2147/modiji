/**
 * THE LEARNER, shared by every strategy: the same knowledge type, the same answer handling and the
 * same rule extraction. It never sees the hidden policy; it only reads what the expert channel
 * returned (observed decisions, counterfactual answers, stated rules).
 *
 * Learned policy = two tiers, evaluated with the solver's rule semantics (`effectiveDecision`:
 * highest firing priority wins, explicit overrides, conflicts detected):
 *   1. Stated rules, promoted to ConfirmedRules with the engine's `promoteToConfirmedRule`, at the
 *      priority and with the override edges the expert stated. Their evidence is SYNTHETIC and
 *      marked bench-only (`bench-synthetic:` ids): the simulated expert's statement stands in for
 *      a recorded quote. As in the product, confirmed rules are authoritative.
 *   2. Induced rules, for the observations no stated decision rule decides (the residual). The
 *      engine enumerates the hypothesis space on the residual (`enumerateCandidates`: thresholds at
 *      observed boundaries, conjunctions of ≤2 conditions, prior ∝ exp(−λ·complexity)), and an
 *      ordered covering turns the single-rule hypotheses into a decision list: repeatedly take the
 *      candidate h = (p, a) with the highest log-posterior gain on the observations it would
 *      decide, Σ_covered log(P(a_obs | h)·|A|) − λ·complexity (P(a|h) is the engine's noise
 *      likelihood; |A|⁻¹ is the uninformative likelihood of an observation left to later rules),
 *      add it below the previous one, remove what it covers; stop when no candidate gains. Induced
 *      rules sit below every stated rule, so they only decide where the stated rules do not.
 * Unresolved cases (no rule fires) get the fallback: the default the expert stated, else the most
 * frequent action among the residual observations no induced rule covers, else the most frequent
 * observed action. A conflict (two equal-priority rules with different actions, possible only with
 * vague statements) goes to the conflicting action observed most often.
 */
import {
  actionLikelihood,
  checkAction,
  engineConfig,
  enumerateCandidates,
  evaluatePredicate,
  familyModel,
  promoteToConfirmedRule,
  recordLookup,
  SCREEN_FRAME_KIND,
  type ActionId,
  type Assignment,
  type ConfirmedRule,
  type EngineConfig,
  type FamilyModel,
  type LedgerReader,
  type Observation,
} from "@vashistha/core";
import { effectiveDecision, prepareRulebook, type Rulebook, type SolverRule } from "@vashistha/solver";
import { APPROVE, DOMAIN, FAMILY, FAMILY_ID } from "./domain";
import type { BenchQuestion, ExpertAnswer, ExpertStatement } from "./expert";

/**
 * Engine settings for the bench (documented in the report): the simplest 2000 candidates and one
 * round threshold per observed boundary keep a refit well under a second; everything else is the
 * engine default (λ = 1, ε = 0.05, conjunctions of ≤ 2 conditions).
 */
export const BENCH_ENGINE_CONFIG: EngineConfig = engineConfig({ maxCandidates: 2000, roundThresholdsPerBoundary: 1 });
export const FAMILY_MODEL: FamilyModel = familyModel(DOMAIN, FAMILY_ID, BENCH_ENGINE_CONFIG);
const MAX_INDUCED_RULES = 16;

export type Knowledge = {
  /** Observed decisions and answered counterfactuals, in arrival order. */
  observations: Observation[];
  /** Stated rules; a restated rule (same id) replaces the earlier statement. */
  statements: ExpertStatement[];
  statedDefault?: ActionId;
};

export const EMPTY_KNOWLEDGE: Knowledge = { observations: [], statements: [] };

export function observe(k: Knowledge, caseId: string, features: Assignment, action: ActionId): Knowledge {
  return { ...k, observations: [...k.observations, { id: caseId, caseId, features, action }] };
}

/** Folds one answer into the knowledge (the only way any strategy learns from a question). */
export function absorb(k: Knowledge, question: BenchQuestion, answer: ExpertAnswer): Knowledge {
  if (answer.kind === "counterfactual") {
    if (question.kind !== "counterfactual") throw new RangeError("counterfactual answer to a why-question");
    return observe(k, question.caseId, question.features, answer.action);
  }
  const byId = new Map(k.statements.map((s) => [s.id, s]));
  for (const s of answer.statements) byId.set(s.id, s);
  const next: Knowledge = { ...k, statements: [...byId.values()] };
  return answer.defaultAction === undefined ? next : { ...next, statedDefault: answer.defaultAction };
}

export type LearnedPolicy = {
  stated: ConfirmedRule[];
  induced: SolverRule[];
  fallback: ActionId;
  book: Rulebook;
  /** Observed action counts, for conflict resolution. */
  frequency: ReadonlyMap<ActionId, number>;
};

export type Prediction = { action: ActionId; resolution: "decided" | "fallback" | "conflict"; approveAllowed: boolean };

const SYNTHETIC = "bench-synthetic";
/** Bench-only ledger: every synthetic id exists and comes from the (simulated) expert. */
const SYNTHETIC_FRAME = `${SYNTHETIC}:frame`;
const SYNTHETIC_LEDGER: LedgerReader = {
  get: (id) =>
    id === SYNTHETIC_FRAME
      ? { id, source: "client", kind: SCREEN_FRAME_KIND }
      : id.startsWith(`${SYNTHETIC}:`)
        ? { id, source: "expert", kind: "expert.statement" }
        : undefined,
};

function statedRuleId(statementId: string): string {
  return `bench.stated.${statementId}`;
}

function promote(s: ExpertStatement, known: ReadonlySet<string>): ConfirmedRule {
  const result = promoteToConfirmedRule({
    ruleId: statedRuleId(s.id),
    domain: DOMAIN,
    decisionFamily: FAMILY_ID,
    source: { statedRule: s.rule },
    priority: s.priority,
    overrides: s.overrides.filter((o) => known.has(o)).map(statedRuleId),
    evidence: [
      {
        kind: "expert_quote",
        utteranceId: `${SYNTHETIC}:utterance:${s.id}`,
        exactQuote: s.rule.exactQuote,
        t0Ms: s.rule.t0Ms,
        t1Ms: s.rule.t1Ms,
        frameIds: [SYNTHETIC_FRAME],
        eventIds: [],
        relation: "supports",
        provenance: "human_text",
      },
    ],
    confirmation: { expertId: `${SYNTHETIC}:expert`, at: 0, method: "explicit_statement", ledgerEntryId: `${SYNTHETIC}:confirmation:${s.id}` },
    expertId: `${SYNTHETIC}:expert`,
    schemaVersion: 1,
    ledger: SYNTHETIC_LEDGER,
  });
  if (!result.ok) throw new Error(`stated rule ${s.id} failed promotion: ${JSON.stringify(result.errors)}`);
  return result.rule;
}

function statedRules(k: Knowledge): ConfirmedRule[] {
  const known = new Set(k.statements.map((s) => s.id));
  return k.statements.map((s) => promote(s, known));
}

/** Observations the stated decision rules leave unresolved: what the induced tier must explain. */
export function residualObservations(k: Knowledge): Observation[] {
  return unresolvedBy(statedRules(k), k.observations);
}

function unresolvedBy(rules: readonly ConfirmedRule[], observations: readonly Observation[]): Observation[] {
  const book = prepareRulebook(DOMAIN, rules);
  return observations.filter((o) => effectiveDecision(book, FAMILY, recordLookup(o.features)).kind === "unresolved");
}

/** Pure function of the knowledge (order of observations only matters through stable tie-breaks). */
export function fitPolicy(k: Knowledge): LearnedPolicy {
  const stated = statedRules(k);
  const residual = unresolvedBy(stated, k.observations);
  const { rules, uncovered } = induce(residual, Math.min(0, ...stated.map((r) => r.priority)) - 1);
  const frequency = countActions(k.observations);
  const fallback = k.statedDefault ?? mostFrequent(countActions(uncovered)) ?? mostFrequent(frequency) ?? FAMILY_MODEL.defaultAction;
  return { stated, induced: rules, fallback, book: prepareRulebook(DOMAIN, [...stated, ...rules]), frequency };
}

function induce(residual: readonly Observation[], topPriority: number): { rules: SolverRule[]; uncovered: Observation[] } {
  if (residual.length === 0) return { rules: [], uncovered: [] };
  const k = FAMILY.actions.length;
  const lookups = residual.map((o) => recordLookup(o.features));
  const candidates = enumerateCandidates(FAMILY_MODEL, residual, BENCH_ENGINE_CONFIG).map((c) => ({
    seed: c,
    covers: lookups.map((l) => evaluatePredicate(c.predicate, l).truth === true),
    gains: residual.map((o) => Math.log(actionLikelihood(FAMILY_MODEL, c.predictedAction, o.action) * k)),
  }));
  const remaining = residual.map(() => true);
  const rules: SolverRule[] = [];
  while (rules.length < MAX_INDUCED_RULES) {
    let best: { index: number; score: number } | undefined;
    candidates.forEach((c, index) => {
      let gain = 0;
      let covered = false;
      for (let i = 0; i < residual.length; i++)
        if (remaining[i] === true && c.covers[i] === true) {
          gain += c.gains[i] ?? 0;
          covered = true;
        }
      const score = gain - BENCH_ENGINE_CONFIG.lambda * c.seed.complexity;
      if (covered && score > 0 && (best === undefined || score > best.score)) best = { index, score };
    });
    const chosen = best === undefined ? undefined : candidates[best.index];
    if (chosen === undefined) break;
    chosen.covers.forEach((hit, i) => {
      if (hit) remaining[i] = false;
    });
    rules.push({
      id: `bench.induced.${rules.length + 1}`,
      decisionFamily: FAMILY_ID,
      kind: "decision",
      predicate: chosen.seed.predicate,
      effect: { type: "recommend", action: chosen.seed.predictedAction },
      priority: topPriority - rules.length,
      overrides: [],
    });
  }
  return { rules, uncovered: residual.filter((_, i) => remaining[i] === true) };
}

function countActions(observations: readonly Observation[]): Map<ActionId, number> {
  const counts = new Map<ActionId, number>();
  for (const o of observations) counts.set(o.action, (counts.get(o.action) ?? 0) + 1);
  return counts;
}

/** Most frequent action; ties go to the earlier action of the family. */
function mostFrequent(counts: ReadonlyMap<ActionId, number>): ActionId | undefined {
  let best: ActionId | undefined;
  for (const a of FAMILY.actions) if ((counts.get(a) ?? 0) > 0 && (best === undefined || (counts.get(a) ?? 0) > (counts.get(best) ?? 0))) best = a;
  return best;
}

export function predict(policy: LearnedPolicy, features: Assignment): Prediction {
  const lookup = recordLookup(features);
  const approveAllowed = checkAction({ rules: policy.stated, features: lookup, action: APPROVE, domain: DOMAIN }).decision === "allow";
  const eff = effectiveDecision(policy.book, FAMILY, lookup);
  switch (eff.kind) {
    case "decided":
      return { action: eff.outcome.label, resolution: "decided", approveAllowed };
    case "unresolved":
      return { action: policy.fallback, resolution: "fallback", approveAllowed };
    case "conflict": {
      const actions = new Map<ActionId, number>();
      for (const id of eff.ruleIds) {
        const effect = policy.book.byId.get(id)?.effect;
        if (effect?.type === "recommend") actions.set(effect.action, policy.frequency.get(effect.action) ?? 0);
      }
      return { action: mostFrequent(actions) ?? [...actions.keys()][0] ?? policy.fallback, resolution: "conflict", approveAllowed };
    }
  }
}
