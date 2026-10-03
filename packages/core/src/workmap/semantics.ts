/**
 * Rule semantics the Work Map and the coverage criteria read: which confirmed rules explain an
 * observed decision, and the decision cell of a case. They mirror the solver's reference semantics
 * (`@vashistha/solver` semantics.ts, which core cannot import) on Kleene-evaluated cases:
 *
 *   - a rule *fires* when its predicate is true and no rule that lists it in `overrides` is true;
 *     a firing that depends on an unknown value is undetermined, and nothing undetermined explains;
 *   - a *decision rule* of a family has effect `recommend` (an action of the family) or `route`;
 *   - the family's effective decision is the outcome shared by every firing decision rule at the
 *     highest firing priority (`decided`), else `conflict`; with no firing decision rule, `unresolved`.
 *
 * A decision is explained when the effective decision is `decided` with exactly the action taken.
 */
import type { DecisionFamily, DomainConfig } from "../schemas/domain";
import type { Assignment } from "../schemas/engine";
import type { ComparisonOp, Operand, Predicate } from "../schemas/predicate";
import type { ConfirmedRule, ExpertQuoteEvidence } from "../schemas/rules";
import type { FeatureValue } from "../schemas/primitives";
import { evaluatePredicate, type FeatureLookup } from "../logic/evaluate";
import { predicateNode } from "../logic/node";
import { canonicalJson } from "../engine/canonical";
import { recordLookup } from "../engine/model";

/** The part of a rule these semantics read (confirmed rules, and rules being validated before confirmation). */
export type ExplainableRule = Pick<ConfirmedRule, "id" | "decisionFamily" | "predicate" | "effect" | "priority" | "overrides">;
type Rule = ExplainableRule;

export type Firing = true | false | "unknown";

/** Whether `rule` fires on the case (three-valued): predicate true and every overrider false. */
export function ruleFires(rule: Rule, rules: readonly Rule[], lookup: FeatureLookup): Firing {
  const own = evaluatePredicate(rule.predicate, lookup).truth;
  if (own === false) return false;
  const overriders = rules.filter((o) => o.overrides.includes(rule.id)).map((o) => evaluatePredicate(o.predicate, lookup).truth);
  if (overriders.includes(true)) return false;
  return own === true && overriders.every((t) => t === false) ? true : "unknown";
}

/** The family's decision rules with the outcome label each one decides (an action, or a route destination). */
export function decisionRulesOf<R extends Rule>(rules: readonly R[], family: DecisionFamily): { rule: R; outcome: string }[] {
  return rules.flatMap((rule) => {
    if (rule.decisionFamily !== family.id) return [];
    if (rule.effect.type === "recommend" && family.actions.includes(rule.effect.action)) return [{ rule, outcome: `action:${rule.effect.action}` }];
    if (rule.effect.type === "route") return [{ rule, outcome: `route:${rule.effect.destination}` }];
    return [];
  });
}

export type EffectiveOutcome =
  | { kind: "decided"; outcome: string; ruleIds: string[] }
  | { kind: "conflict"; ruleIds: string[] }
  | { kind: "unresolved" }
  | { kind: "undetermined" };

/** The family's effective decision on a case; `undetermined` when an unknown value could change it. */
export function effectiveOutcome(rules: readonly Rule[], family: DecisionFamily, lookup: FeatureLookup): EffectiveOutcome {
  const decision = decisionRulesOf(rules, family).map((d) => ({ ...d, fires: ruleFires(d.rule, rules, lookup) }));
  if (decision.some((d) => d.fires === "unknown")) return { kind: "undetermined" };
  const fired = decision.filter((d) => d.fires === true);
  if (fired.length === 0) return { kind: "unresolved" };
  const top = Math.max(...fired.map((d) => d.rule.priority));
  const atTop = fired.filter((d) => d.rule.priority === top);
  const ruleIds = atTop.map((d) => d.rule.id).sort();
  const outcomes = new Set(atTop.map((d) => d.outcome));
  const [outcome] = outcomes;
  return outcomes.size === 1 && outcome !== undefined ? { kind: "decided", outcome, ruleIds } : { kind: "conflict", ruleIds };
}

export type DecisionExplanation = {
  explained: boolean;
  /** Decision rules that decide the taken action (empty unless explained). */
  ruleIds: string[];
  /** Guardrails in force on the case for this family: `forbid` of one of its actions, or `require_approval` of the family. */
  guardrailIds: string[];
  outcome: EffectiveOutcome;
};

export function explainDecision(input: { rules: readonly Rule[]; family: DecisionFamily; action: string; lookup: FeatureLookup }): DecisionExplanation {
  const { rules, family, action, lookup } = input;
  const outcome = effectiveOutcome(rules, family, lookup);
  const explained = outcome.kind === "decided" && outcome.outcome === `action:${action}`;
  const guardrailIds = rules
    .filter(
      (r) =>
        (r.effect.type === "forbid" && family.actions.includes(r.effect.action)) ||
        (r.effect.type === "require_approval" && r.decisionFamily === family.id),
    )
    .filter((r) => ruleFires(r, rules, lookup) === true)
    .map((r) => r.id)
    .sort();
  return { explained, ruleIds: explained && outcome.kind === "decided" ? outcome.ruleIds : [], guardrailIds, outcome };
}

/** The family an action belongs to (first in domain order). */
export function familyOfAction(domain: DomainConfig, action: string): DecisionFamily | undefined {
  return domain.decisionFamilies.find((f) => f.actions.some((a) => a === action));
}

/** Supporting expert quotes of a rule, in evidence order. */
export function supportingQuotes(rule: Pick<ConfirmedRule, "evidence">): ExpertQuoteEvidence[] {
  return rule.evidence.filter((e): e is ExpertQuoteEvidence => e.kind === "expert_quote" && e.relation === "supports");
}

// ── Decision cells ──

/** The atomic conditions (comparisons and memberships) of a predicate, left to right. */
export function atomicConditions(p: Predicate): Predicate[] {
  const node = predicateNode(p);
  return node.key === "and" || node.key === "or" || node.key === "!" ? node.args.flatMap(atomicConditions) : [p];
}

export type CellLiteral = { condition: Predicate; holds: boolean };

/**
 * The decision cell of a complete case for a family: the truth value of every distinct atomic
 * condition the family's decision rules and their overriders use (first-use order). Two cases in the
 * same cell are indistinguishable to the current rulebook: it decides them alike.
 */
export function decisionCell(rules: readonly Rule[], family: DecisionFamily, assignment: Assignment): CellLiteral[] {
  const lookup = recordLookup(assignment as Record<string, FeatureValue>);
  const decision = decisionRulesOf(rules, family).map((d) => d.rule);
  const relevant = decision.flatMap((r) => [r.predicate, ...rules.filter((o) => o.overrides.includes(r.id)).map((o) => o.predicate)]);
  const seen = new Set<string>();
  const out: CellLiteral[] = [];
  for (const condition of relevant.flatMap(atomicConditions)) {
    const key = canonicalJson(condition);
    if (seen.has(key)) continue;
    seen.add(key);
    const { truth } = evaluatePredicate(condition, lookup);
    if (truth === "unknown") throw new RangeError("decision cells are defined on complete cases only");
    out.push({ condition, holds: truth });
  }
  return out;
}

const OPPOSITE = { "==": "!=", "!=": "==", "<": ">=", "<=": ">", ">": "<=", ">=": "<" } as const satisfies Record<ComparisonOp, ComparisonOp>;

function comparison(op: ComparisonOp, l: Operand, r: Operand): Predicate {
  switch (op) {
    case "==":
      return { "==": [l, r] };
    case "!=":
      return { "!=": [l, r] };
    case "<":
      return { "<": [l, r] };
    case "<=":
      return { "<=": [l, r] };
    case ">":
      return { ">": [l, r] };
    case ">=":
      return { ">=": [l, r] };
  }
}

/**
 * The negation of an atomic condition as a comparison where one exists (`a > 25` → `a <= 25`;
 * `b == false` → `b == true`), else `!`. Equivalent under Kleene evaluation: an unknown operand
 * leaves both unknown.
 */
export function negateCondition(p: Predicate): Predicate {
  const node = predicateNode(p);
  if (node.key === "and" || node.key === "or" || node.key === "!" || node.key === "in") return { "!": [p] };
  const [l, r] = node.args;
  if ((node.key === "==" || node.key === "!=") && typeof r === "boolean") return comparison(node.key, l, !r);
  if ((node.key === "==" || node.key === "!=") && typeof l === "boolean") return comparison(node.key, !l, r);
  return comparison(OPPOSITE[node.key], l, r);
}

/** The cell as a predicate (each condition, negated where it is false); undefined for the empty cell. */
export function cellPredicate(cell: readonly CellLiteral[]): Predicate | undefined {
  const literals = cell.map((l): Predicate => (l.holds ? l.condition : negateCondition(l.condition)));
  const [first, ...rest] = literals;
  if (first === undefined) return undefined;
  return rest.length === 0 ? first : { and: [first, ...rest] };
}

/** Whether two complete cases fall in the same decision cell of `family` under `rules`. */
export function sameDecisionCell(rules: readonly Rule[], family: DecisionFamily, a: Assignment, b: Assignment): boolean {
  const ca = decisionCell(rules, family, a);
  const cb = decisionCell(rules, family, b);
  return ca.every((l, i) => cb[i]?.holds === l.holds);
}
