import type { HypothesisSet } from "../schemas/rules";
import type { EngineConfig } from "./config";
import { actionIndex, predictive, recordLookup, type FamilyModel, type Observation } from "./model";

export type Surprise = { observationId: string; probability: number; bits: number };

/**
 * Surprise of an observed decision under the family's current hypothesis set (plan §7.3):
 * P(a) = Σ_h w_h·P(a|h), surprise = −log₂ P(a). Call it BEFORE updating on the observation.
 * An empty set predicts uniformly (surprise log₂|A|).
 */
export function surprise(model: FamilyModel, set: HypothesisSet, observation: Observation): Surprise {
  const p = predictive(model, set.candidates, recordLookup(observation.features))[actionIndex(model, observation.action)] ?? 0;
  return { observationId: observation.id, probability: p, bits: -Math.log2(p) };
}

/** "contradiction detected": the decision was less likely than 2^−contradictionBits under the current hypotheses. */
export function isContradiction(s: Surprise, config: EngineConfig): boolean {
  return s.bits >= config.contradictionBits;
}
