import { z } from "zod";
import type { DecisionContext } from "../schemas/context";
import type { DecisionFamily, DomainConfig } from "../schemas/domain";
import { evaluatePredicate, type FeatureLookup } from "../logic/evaluate";
import { contextLookup } from "../logic/context";
import {
  ActionIdSchema,
  FeatureIdSchema,
  FeatureValueSchema,
  IdSchema,
  unknown,
  type ActionId,
  type FeatureId,
  type FeatureValue,
} from "../schemas/primitives";
import type { CandidateRule } from "../schemas/rules";
import type { EngineConfig } from "./config";

/**
 * One observed decision of a family: the expert took `action` on a case whose features (case and
 * derived, flattened) were `features`. `id` is the ledger entry of the decision (or, for an answered
 * counterfactual, of the answer).
 */
export const ObservationSchema = z.strictObject({
  id: IdSchema,
  caseId: z.string().min(1),
  features: z.record(FeatureIdSchema, FeatureValueSchema),
  action: ActionIdSchema,
});
export type Observation = z.infer<typeof ObservationSchema>;

/**
 * Everything the likelihood needs about a decision family.
 *
 * Hypothesis formulation. A candidate h = (p, a) means "if p then a else d", where d is the
 * family's default action (`config.defaultActions[family]`, else the family's first action, e.g.
 * `approve`). Every hypothesis therefore predicts exactly one action on every fully known case, so
 * P(a|h) = 1−ε / ε/(|A|−1) (plan §7.3) is well defined everywhere — including on counterfactuals,
 * which is what EIG needs. A rule *list* would also be well defined but its space is the product of
 * the rule spaces, and `CandidateRule` carries a single predicate and action; an "abstain when p is
 * false" reading would leave P(a|h) undefined off the rule. The default is per family, not per
 * candidate, because `CandidateRule` has no field for it; candidates never predict the default
 * itself (that would be indistinguishable from "no rule").
 */
export type FamilyModel = {
  domain: DomainConfig;
  family: DecisionFamily;
  defaultAction: ActionId;
  epsilon: number;
};

export function familyModel(domain: DomainConfig, familyId: string, config: EngineConfig): FamilyModel {
  const family = domain.decisionFamilies.find((f) => f.id === familyId);
  if (family === undefined) throw new RangeError(`unknown decision family "${familyId}" in domain "${domain.id}"`);
  const defaultAction = config.defaultActions[familyId] ?? family.actions[0];
  if (defaultAction === undefined || !family.actions.includes(defaultAction))
    throw new RangeError(`default action of family "${familyId}" is not one of its actions`);
  return { domain, family, defaultAction, epsilon: config.expertNoisePrior };
}

/** Lookup over a flattened feature record; an absent feature is `unknown("not_extracted")`. */
export function recordLookup(features: Readonly<Record<string, FeatureValue>>): FeatureLookup {
  return (id) => (Object.hasOwn(features, id) ? features[id] : undefined) ?? unknown("not_extracted");
}

/** Every declared feature of the domain read from a decision context (case and derived). */
export function flattenContext(ctx: DecisionContext, domain: DomainConfig): Record<FeatureId, FeatureValue> {
  const lookup = contextLookup(ctx, domain.features);
  return Object.fromEntries(domain.features.map((f) => [f.id, lookup(f.id)])) as Record<FeatureId, FeatureValue>;
}

type Rule = Pick<CandidateRule, "predicate" | "predictedAction">;

/** The action h predicts on a case, or "unknown" when its predicate cannot be evaluated there. */
export function predictedAction(model: FamilyModel, h: Rule, lookup: FeatureLookup): ActionId | "unknown" {
  const { truth } = evaluatePredicate(h.predicate, lookup);
  if (truth === "unknown") return "unknown";
  return truth ? h.predictedAction : model.defaultAction;
}

/** P(a | h predicts `predicted`) under the expert-noise model. */
export function actionLikelihood(model: FamilyModel, predicted: ActionId, a: ActionId): number {
  const k = model.family.actions.length;
  if (k === 1) return 1;
  return a === predicted ? 1 - model.epsilon : model.epsilon / (k - 1);
}

type Weighted = Pick<CandidateRule, "predicate" | "predictedAction" | "weight">;

/**
 * P(a|h) for one case: one row per candidate, one column per family action (in
 * `model.family.actions` order); every row sums to 1.
 *
 * Unknown features: a candidate whose predicate evaluates "unknown" makes no prediction, so its row
 * is the marginal of the candidates that do, P_known(a) = Σ_known w·P(a|h) / Σ_known w (uniform
 * 1/|A| when none can evaluate). Consequences: the total weight of the non-evaluating candidates is
 * exactly preserved by a Bayesian update (a case they cannot see neither confirms nor refutes
 * them), and the predictive P(a) used for surprise equals P_known(a).
 */
export function likelihoodMatrix(model: FamilyModel, candidates: readonly Weighted[], lookup: FeatureLookup): number[][] {
  const actions = model.family.actions;
  const known = new Array<number>(actions.length).fill(0);
  let knownMass = 0;
  const rows = candidates.map((h) => {
    const p = predictedAction(model, h, lookup);
    if (p === "unknown") return undefined;
    const row = actions.map((a) => actionLikelihood(model, p, a));
    knownMass += h.weight;
    row.forEach((l, j) => (known[j] = (known[j] ?? 0) + h.weight * l));
    return row;
  });
  const marginal = knownMass > 0 ? known.map((l) => l / knownMass) : actions.map(() => 1 / actions.length);
  return rows.map((row) => row ?? marginal);
}

/** Posterior predictive P(a) = Σ_h w_h·P(a|h), in `model.family.actions` order (uniform for an empty set). */
export function predictive(model: FamilyModel, candidates: readonly Weighted[], lookup: FeatureLookup): number[] {
  const actions = model.family.actions;
  if (candidates.length === 0) return actions.map(() => 1 / actions.length);
  const matrix = likelihoodMatrix(model, candidates, lookup);
  return actions.map((_, j) => matrix.reduce((s, row, i) => s + (row[j] ?? 0) * (candidates[i]?.weight ?? 0), 0));
}

export function actionIndex(model: FamilyModel, action: ActionId): number {
  const j = model.family.actions.indexOf(action);
  if (j < 0) throw new RangeError(`action "${action}" is not in decision family "${model.family.id}"`);
  return j;
}
