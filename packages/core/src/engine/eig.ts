import type { FeatureLookup } from "../logic/evaluate";
import type { HypothesisSet } from "../schemas/rules";
import { likelihoodMatrix, type FamilyModel } from "./model";

/** Shannon entropy in bits of a distribution (zero entries contribute 0). */
export function entropy(p: readonly number[]): number {
  return p.reduce((h, x) => (x > 0 ? h - x * Math.log2(x) : h), 0);
}

/**
 * Expected information gain (bits) of asking "what would you do on this case?", as mutual
 * information between the hypothesis W and the answer A_q:
 *   I = H(A_q) − Σ_h w_h·H(A_q | h),
 * where P(a|h) is h's prediction on the case under the expert-noise model (model.ts).
 * `weights[i]` and `likelihoods[i][j]` = P(a_j | h_i) for each candidate i.
 */
export function mutualInformation(weights: readonly number[], likelihoods: readonly (readonly number[])[]): number {
  const k = likelihoods[0]?.length ?? 0;
  const pa = new Array<number>(k).fill(0);
  let conditional = 0;
  weights.forEach((w, i) => {
    const row = likelihoods[i] ?? [];
    row.forEach((l, j) => (pa[j] = (pa[j] ?? 0) + w * l));
    conditional += w * entropy(row);
  });
  return Math.max(0, entropy(pa) - conditional);
}

/**
 * The textbook form IG = H(W) − Σ_a P(a)·H(W | a), with W | a the Bayesian posterior after hearing
 * answer a. Identical in value to `mutualInformation` (I(W;A) is symmetric); kept as the reference
 * the cheaper form is tested against.
 */
export function informationGain(weights: readonly number[], likelihoods: readonly (readonly number[])[]): number {
  const k = likelihoods[0]?.length ?? 0;
  let expectedPosteriorEntropy = 0;
  for (let j = 0; j < k; j++) {
    const joint = weights.map((w, i) => w * (likelihoods[i]?.[j] ?? 0));
    const pa = joint.reduce((s, x) => s + x, 0);
    if (pa > 0) expectedPosteriorEntropy += pa * entropy(joint.map((x) => x / pa));
  }
  return Math.max(0, entropy(weights) - expectedPosteriorEntropy);
}

/** EIG (bits) of asking for the expert's decision on a (counterfactual) case. */
export function counterfactualEig(model: FamilyModel, set: HypothesisSet, lookup: FeatureLookup): number {
  if (set.candidates.length === 0) return 0;
  return mutualInformation(
    set.candidates.map((c) => c.weight),
    likelihoodMatrix(model, set.candidates, lookup),
  );
}
