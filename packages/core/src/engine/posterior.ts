import { predicateNode } from "../logic/node";
import { isVarRef, type Predicate } from "../schemas/predicate";
import type { HypothesisSet } from "../schemas/rules";
import { canonicalJson } from "./canonical";
import type { EngineConfig } from "./config";
import { enumerateCandidates, type CandidateSeed } from "./enumerate";
import { actionIndex, likelihoodMatrix, predictedAction, recordLookup, type FamilyModel, type Observation } from "./model";
import { surprise, type Surprise } from "./surprise";

/**
 * Everything a family's hypothesis set is a deterministic function of. The set is rebuilt from it
 * (enumeration depends on the observed boundaries, so new observations add new candidates, whose
 * weights must reflect all earlier observations too).
 */
export type FamilyKnowledge = {
  /** Observed decisions and answered counterfactuals, in order. */
  observations: Observation[];
  /** Candidates the expert stated (origin `expert_statement`), already type-checked. */
  statedCandidates: CandidateSeed[];
  /** Candidates the expert's answers ruled out; they never re-enter the set. */
  eliminatedIds: string[];
};

export const EMPTY_KNOWLEDGE: FamilyKnowledge = { observations: [], statedCandidates: [], eliminatedIds: [] };

/**
 * Prior group of a candidate under `priorGrouping: "per_feature_direction"` (config.ts): the
 * predicted action plus, per top-level condition, (feature, up|down) for a threshold comparison or
 * the condition itself otherwise.
 */
export function priorGroupKey(c: Pick<CandidateSeed, "predicate" | "predictedAction">): string {
  const node = predicateNode(c.predicate);
  const parts = node.key === "and" ? node.args : [c.predicate];
  return canonicalJson({ action: c.predictedAction, conditions: parts.map(conditionGroup).sort() });
}

function conditionGroup(p: Predicate): string {
  const node = predicateNode(p);
  if (node.key === "<" || node.key === "<=" || node.key === ">" || node.key === ">=") {
    const [l, r] = node.args;
    const up = node.key === ">" || node.key === ">=";
    if (isVarRef(l) && typeof r === "number") return `${l.var}:${up ? "up" : "down"}`;
    if (isVarRef(r) && typeof l === "number") return `${r.var}:${up ? "down" : "up"}`;
  }
  return canonicalJson(p);
}

/** Log prior weights (unnormalised) of `seeds` under the configured grouping; see `priorGrouping`. */
function logPriors(seeds: readonly CandidateSeed[], config: EngineConfig): number[] {
  const own = seeds.map((s) => -config.lambda * s.complexity);
  const bonus = seeds.map((s) => (s.origin === "expert_statement" ? Math.log(config.statedRulePriorMultiplier) : 0));
  if (config.priorGrouping === "per_hypothesis") return own.map((l, i) => l + (bonus[i] ?? 0));
  const groups = new Map<string, number[]>();
  seeds.forEach((s, i) => {
    const key = priorGroupKey(s);
    groups.set(key, [...(groups.get(key) ?? []), i]);
  });
  const out = new Array<number>(seeds.length).fill(0);
  for (const members of groups.values()) {
    const ls = members.map((i) => own[i] ?? 0);
    const unit = Math.max(...ls); // exp(−λ·lowest complexity in the group)
    const share = logSumExp(ls);
    members.forEach((i, k) => (out[i] = unit + (ls[k] ?? 0) - share + (bonus[i] ?? 0)));
  }
  return out;
}

/** Prior ∝ exp(−λ·complexity) per hypothesis or per group (`priorGrouping`), × `statedRulePriorMultiplier` for expert statements; normalised. */
export function priorSet(params: {
  id: string;
  model: FamilyModel;
  seeds: readonly CandidateSeed[];
  schemaVersion: number;
  normalizationVersion: number;
  config: EngineConfig;
}): HypothesisSet {
  const { id, model, seeds, schemaVersion, normalizationVersion, config } = params;
  const weights = normalizeLog(logPriors(seeds, config));
  return {
    id,
    decisionFamily: model.family.id,
    candidates: seeds.map((s, i) => ({ ...s, hypothesisSetId: id, weight: weights[i] ?? 0 })),
    normalizationVersion,
    schemaVersion,
  };
}

/** One Bayesian update w_h ← w_h·P(a|h) / Σ w·P(a|h) (unknown-feature rule: model.ts). */
export function updatePosterior(model: FamilyModel, set: HypothesisSet, observation: Observation): HypothesisSet {
  const j = actionIndex(model, observation.action);
  if (set.candidates.length === 0) return set;
  const matrix = likelihoodMatrix(model, set.candidates, recordLookup(observation.features));
  const raw = set.candidates.map((c, i) => c.weight * (matrix[i]?.[j] ?? 0));
  const total = raw.reduce((s, x) => s + x, 0);
  return {
    ...set,
    candidates: set.candidates.map((c, i) => ({ ...c, weight: (raw[i] ?? 0) / total })),
    normalizationVersion: set.normalizationVersion + 1,
  };
}

/**
 * Enumerates (plus stated candidates, minus eliminated ones), applies the prior, then updates on
 * every observation in order. `previous` carries the normalisation counter forward.
 */
export function buildHypothesisSet(params: {
  setId: string;
  model: FamilyModel;
  knowledge: FamilyKnowledge;
  schemaVersion: number;
  config: EngineConfig;
  previous?: HypothesisSet;
}): HypothesisSet {
  const { setId, model, knowledge, schemaVersion, config, previous } = params;
  const eliminated = new Set(knowledge.eliminatedIds);
  const byId = new Map<string, CandidateSeed>();
  for (const s of enumerateCandidates(model, knowledge.observations, config)) byId.set(s.id, s);
  // A stated candidate identical to an enumerated one replaces it: the expert said it.
  for (const s of knowledge.statedCandidates) byId.set(s.id, s);
  const seeds = [...byId.values()].filter((s) => !eliminated.has(s.id));
  const prior = priorSet({ id: setId, model, seeds, schemaVersion, normalizationVersion: previous?.normalizationVersion ?? 0, config });
  const updated = knowledge.observations.reduce((set, o) => updatePosterior(model, set, o), prior);
  return { ...updated, normalizationVersion: (previous?.normalizationVersion ?? 0) + 1 };
}

/**
 * A decision as the engine saw it arrive, judged against the hypotheses held BEFORE learning from
 * it: its surprise and the mass of candidates that predicted it.
 */
export type RecentDecision = { observation: Observation; surprise: Surprise; explainedMass: number };

/** The live step: judge a new decision against the current set, then rebuild the set with it. */
export function observeDecision(params: {
  model: FamilyModel;
  set: HypothesisSet;
  knowledge: FamilyKnowledge;
  observation: Observation;
  config: EngineConfig;
}): { recent: RecentDecision; knowledge: FamilyKnowledge; set: HypothesisSet } {
  const { model, set, knowledge, observation, config } = params;
  const recent = { observation, surprise: surprise(model, set, observation), explainedMass: explainedMass(model, set, observation) };
  const next = { ...knowledge, observations: [...knowledge.observations, observation] };
  return {
    recent,
    knowledge: next,
    set: buildHypothesisSet({ setId: set.id, model, knowledge: next, schemaVersion: set.schemaVersion, config, previous: set }),
  };
}

/** Mass of the candidates that predict `observation.action` on its case (0 for an empty set). */
export function explainedMass(model: FamilyModel, set: HypothesisSet, observation: Observation): number {
  actionIndex(model, observation.action);
  const lookup = recordLookup(observation.features);
  return set.candidates.reduce((s, c) => (predictedAction(model, c, lookup) === observation.action ? s + c.weight : s), 0);
}

function normalizeLog(logw: readonly number[]): number[] {
  if (logw.length === 0) return [];
  const max = Math.max(...logw);
  const w = logw.map((l) => Math.exp(l - max));
  const total = w.reduce((s, x) => s + x, 0);
  return w.map((x) => x / total);
}

function logSumExp(ls: readonly number[]): number {
  const max = Math.max(...ls);
  return max + Math.log(ls.reduce((s, l) => s + Math.exp(l - max), 0));
}
