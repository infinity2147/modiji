/**
 * Rule semantics shared by every solver query, the JavaScript reference used to re-verify witnesses,
 * and the Z3 encoding of the same semantics (`encodeFamilyDecision`). This is the one place these
 * semantics are defined; it matches the hidden-policy oracle and `checkAction` (plan §6.4, §7.5).
 *
 * Decision rules. A rule is a *decision rule* of its family when its effect is `recommend` of one of
 * the family's actions, or `route`. Its *outcome* is the recommended action or the route
 * destination. A family's actions are its mutually exclusive outcomes, so "terminal" means terminal
 * for the family: `ActionDef.terminal` (case-closing) plays no part, otherwise a family made only of
 * non-closing actions (KYC `riskRating`) could never be resolved. `forbid` and `require_approval`
 * rules are guardrails: they never resolve a family and never conflict with a decision.
 *
 * Firing. A rule fires on a complete assignment when its predicate is true and no rule that lists
 * it in `overrides` (any family, any effect) has a true predicate. Overrides are one level deep: an
 * overrider's own overriders do not matter (as in `checkAction` and the oracle). Override ids that
 * name no rule have no effect.
 *
 * Effective decision of a family. Among its firing decision rules, take the highest priority:
 *   - no decision rule fires                        → `unresolved`
 *   - every firing rule at that priority has one outcome → `decided` (that outcome)
 *   - two outcomes at that priority                 → `conflict`
 * So every valid assignment is exactly one of decided / unresolved / conflict. A conflict therefore
 * needs two rules of equal priority, neither overriding the other (an override edge means the
 * overridden rule never fires alongside its overrider), with different outcomes, both firing, and no
 * firing decision rule of strictly higher priority: a tie shadowed by a higher-priority rule decides
 * nothing and is not reported.
 *
 * Witnesses are complete cases, so unknown values (and `known_f` flags) never arise here.
 */
import {
  ActionIdSchema,
  IdSchema,
  PredicateSchema,
  RuleEffectSchema,
  RuleKindSchema,
  SymbolIdSchema,
  evaluatePredicate,
  typecheckPredicate,
  type ActionId,
  type ConfirmedRule,
  type DecisionFamily,
  type DomainConfig,
  type FeatureLookup,
  type Predicate,
} from "@vashistha/core";
import type { Bool, Context } from "z3-solver";

/** The part of a rule the solver reads. Confirmed rules and hidden-policy rules both fit. */
export type SolverRule = Pick<ConfirmedRule, "id" | "decisionFamily" | "kind" | "predicate" | "effect" | "priority" | "overrides">;

/** Rejected solver input: a rulebook or predicate that does not fit the domain, or bad options. */
export class SolverInputError extends Error {
  readonly issues: readonly string[];
  constructor(issues: readonly string[]) {
    super(`invalid solver input:\n${issues.map((i) => `  ${i}`).join("\n")}`);
    this.name = "SolverInputError";
    this.issues = issues;
  }
}

/**
 * Label of the `unresolved` decision in disagreement witnesses (whose `actions` are ActionIds).
 * A domain may not declare an action with this id, and route destinations must not use it.
 */
export const UNRESOLVED = ActionIdSchema.parse("unresolved");

/** A decision rule's outcome. `label` is what witnesses report: the action, or the route destination. */
export type Outcome = { key: string; label: ActionId };

export type DecisionRule = { rule: SolverRule; outcome: Outcome };

export type EffectiveDecision =
  | { kind: "decided"; outcome: Outcome; ruleIds: string[] }
  | { kind: "unresolved" }
  | { kind: "conflict"; ruleIds: string[] };

/** A validated rulebook with its override index. */
export type Rulebook = {
  rules: readonly SolverRule[];
  byId: ReadonlyMap<string, SolverRule>;
  /** Rule id → the rules that override it. */
  overriders: ReadonlyMap<string, readonly SolverRule[]>;
};

/** Field-wise zod validation of a rule's solver-relevant shape (extra fields, e.g. evidence, are ignored). */
function shapeIssues(rule: SolverRule): string[] {
  const fields: [string, { safeParse(v: unknown): { success: boolean } }, unknown][] = [
    ["id", IdSchema, rule.id],
    ["decisionFamily", SymbolIdSchema, rule.decisionFamily],
    ["kind", RuleKindSchema, rule.kind],
    ["predicate", PredicateSchema, rule.predicate],
    ["effect", RuleEffectSchema, rule.effect],
  ];
  const issues = fields.filter(([, schema, v]) => !schema.safeParse(v).success).map(([name]) => `invalid ${name}`);
  if (!Number.isSafeInteger(rule.priority)) issues.push("priority must be an integer");
  if (!Array.isArray(rule.overrides) || !rule.overrides.every((o) => IdSchema.safeParse(o).success)) issues.push("invalid overrides");
  return issues;
}

/** Validates rules against the domain (shape, ids, family, actions, route labels, predicate types). Throws `SolverInputError`. */
export function prepareRulebook(domain: DomainConfig, rules: readonly SolverRule[]): Rulebook {
  const issues: string[] = [];
  const actionIds = new Set<string>(domain.actions.map((a) => a.id));
  if (actionIds.has(UNRESOLVED)) issues.push(`domain declares an action "${UNRESOLVED}", which is reserved for the unresolved decision`);
  const byId = new Map<string, SolverRule>();
  rules.forEach((rule, i) => {
    const shape = shapeIssues(rule);
    if (shape.length > 0) {
      issues.push(`rules[${i}]: ${shape.join("; ")}`);
      return;
    }
    if (byId.has(rule.id)) issues.push(`rule "${rule.id}": duplicate id`);
    byId.set(rule.id, rule);
    const family = domain.decisionFamilies.find((f) => f.id === rule.decisionFamily);
    if (family === undefined) issues.push(`rule "${rule.id}": unknown decision family "${rule.decisionFamily}"`);
    const { effect } = rule;
    if (effect.type === "recommend" && family !== undefined && !family.actions.includes(effect.action))
      issues.push(`rule "${rule.id}": recommends "${effect.action}", which is not an action of family "${family.id}"`);
    if (effect.type === "forbid" && !actionIds.has(effect.action)) issues.push(`rule "${rule.id}": forbids unknown action "${effect.action}"`);
    if (effect.type === "route") {
      const label = ActionIdSchema.safeParse(effect.destination);
      if (!label.success || actionIds.has(effect.destination) || effect.destination === UNRESOLVED)
        issues.push(`rule "${rule.id}": route destination "${effect.destination}" must be an identifier distinct from every action id and "${UNRESOLVED}"`);
    }
    for (const issue of typecheckPredicate(rule.predicate, domain.features))
      issues.push(`rule "${rule.id}" predicate${issue.path}: ${issue.message}`);
  });
  if (issues.length > 0) throw new SolverInputError(issues);

  const overriders = new Map<string, SolverRule[]>();
  for (const r of rules) for (const id of r.overrides) overriders.set(id, [...(overriders.get(id) ?? []), r]);
  return { rules, byId, overriders };
}

export function decisionFamily(domain: DomainConfig, id: string): DecisionFamily {
  const family = domain.decisionFamilies.find((f) => f.id === id);
  if (family === undefined) throw new SolverInputError([`unknown decision family "${id}" in domain "${domain.id}"`]);
  return family;
}

/** The family's decision rules (rulebook order) with their outcomes. */
export function decisionRules(book: Rulebook, family: DecisionFamily): DecisionRule[] {
  return book.rules.flatMap((rule): DecisionRule[] => {
    if (rule.decisionFamily !== family.id) return [];
    const { effect } = rule;
    if (effect.type === "recommend") return [{ rule, outcome: { key: `action:${effect.action}`, label: effect.action } }];
    if (effect.type === "route")
      return [{ rule, outcome: { key: `route:${effect.destination}`, label: ActionIdSchema.parse(effect.destination) } }];
    return [];
  });
}

/** Predicates that can change whether `rules` fire: their own and their overriders'. */
export function firingPredicates(book: Rulebook, rules: readonly SolverRule[]): Predicate[] {
  return rules.flatMap((r) => [r.predicate, ...(book.overriders.get(r.id) ?? []).map((o) => o.predicate)]);
}

// ---------------------------------------------------------------------------------------------
// JavaScript reference semantics (complete assignments only).

function holds(p: Predicate, lookup: FeatureLookup): boolean {
  const { truth } = evaluatePredicate(p, lookup);
  if (truth === "unknown") throw new Error("solver semantics are defined on complete assignments only");
  return truth;
}

export function fires(book: Rulebook, rule: SolverRule, lookup: FeatureLookup): boolean {
  return holds(rule.predicate, lookup) && !(book.overriders.get(rule.id) ?? []).some((o) => holds(o.predicate, lookup));
}

/** The family's effective decision on a complete assignment (see the module comment). */
export function effectiveDecision(book: Rulebook, family: DecisionFamily, lookup: FeatureLookup): EffectiveDecision {
  const fired = decisionRules(book, family).filter((d) => fires(book, d.rule, lookup));
  if (fired.length === 0) return { kind: "unresolved" };
  const top = Math.max(...fired.map((d) => d.rule.priority));
  const atTop = fired.filter((d) => d.rule.priority === top);
  const ruleIds = atTop.map((d) => d.rule.id).sort();
  const [first] = atTop;
  if (first === undefined || atTop.some((d) => d.outcome.key !== first.outcome.key)) return { kind: "conflict", ruleIds };
  return { kind: "decided", outcome: first.outcome, ruleIds };
}

// ---------------------------------------------------------------------------------------------
// Z3 encoding of the same semantics.

export type FamilyDecisionEncoding = {
  /** Rule id → "this rule fires". */
  fires: ReadonlyMap<string, Bool<"main">>;
  /** "Some decision rule with priority strictly above `p` fires." */
  firesAbove: (p: number) => Bool<"main">;
  /** "The effective decision is `decided` with this outcome", keyed by outcome key. */
  decides: ReadonlyMap<string, { outcome: Outcome; expr: Bool<"main"> }>;
  unresolved: Bool<"main">;
};

export function encodeFamilyDecision(
  ctx: Context<"main">,
  encode: (p: Predicate) => Bool<"main">,
  book: Rulebook,
  family: DecisionFamily,
): FamilyDecisionEncoding {
  const rules = decisionRules(book, family);
  const firesById = new Map<string, Bool<"main">>();
  for (const { rule } of rules) {
    const overriders = (book.overriders.get(rule.id) ?? []).map((o) => encode(o.predicate));
    firesById.set(rule.id, ctx.And(encode(rule.predicate), ctx.Not(ctx.Or(...overriders))));
  }
  const fire = (d: DecisionRule): Bool<"main"> => {
    const e = firesById.get(d.rule.id);
    if (e === undefined) throw new Error(`no encoding for rule "${d.rule.id}"`);
    return e;
  };
  const firesAbove = (p: number): Bool<"main"> => ctx.Or(...rules.filter((d) => d.rule.priority > p).map(fire));

  const priorities = [...new Set(rules.map((d) => d.rule.priority))];
  const outcomes = new Map<string, Outcome>(rules.map((d) => [d.outcome.key, d.outcome]));
  const decides = new Map<string, { outcome: Outcome; expr: Bool<"main"> }>();
  for (const [key, outcome] of outcomes) {
    const atPriority = priorities.map((p) => {
      const here = rules.filter((d) => d.rule.priority === p);
      const mine = here.filter((d) => d.outcome.key === key).map(fire);
      const others = here.filter((d) => d.outcome.key !== key).map(fire);
      return ctx.And(ctx.Or(...mine), ctx.Not(ctx.Or(...others)), ctx.Not(firesAbove(p)));
    });
    decides.set(key, { outcome, expr: ctx.Or(...atPriority) });
  }
  return { fires: firesById, firesAbove, decides, unresolved: ctx.Not(ctx.Or(...rules.map(fire))) };
}
