import type { DomainConfig } from "../schemas/domain";
import type { GuardrailDecision, GuardrailResult } from "../schemas/guardrail";
import type { Predicate } from "../schemas/predicate";
import type { ActionId, FeatureId } from "../schemas/primitives";
import type { ConfirmedRule, EvidenceLink, ExpertQuoteEvidence } from "../schemas/rules";
import { evaluatePredicate, type Evaluation, type FeatureLookup } from "../logic/evaluate";
import { sortedUnique } from "../logic/node";
import { typecheckPredicate } from "../logic/typecheck";

/** The rulebook does not fit the domain. A programming error (rules are validated when confirmed), never user input. */
export class RulebookError extends Error {
  readonly issues: readonly string[];
  constructor(domainId: string, issues: readonly string[]) {
    super(`invalid rulebook for domain "${domainId}":\n${issues.map((i) => `  ${i}`).join("\n")}`);
    this.name = "RulebookError";
    this.issues = issues;
  }
}

export type CheckActionInput = {
  rules: readonly ConfirmedRule[];
  features: FeatureLookup;
  action: ActionId;
  domain: DomainConfig;
};

type Participant = { rule: ConfirmedRule; evaluation: Evaluation };

/**
 * The deterministic Save interlock and MCP `check_action` core (plan §7.7, §7.9): may `action` be
 * taken on a case whose features are given by `features` (possibly with unknowns), under the
 * confirmed rulebook? Pure: no I/O, no clock, no randomness.
 *
 * Participation. Only rules whose effect constrains `action` take part:
 *   - `forbid` with `effect.action === action`;
 *   - `require_approval` whose decision family lists `action` in the domain.
 * `recommend` and `route` effects never block; they inform the tutor.
 *
 * Overrides. A participating rule R is suppressed when a rule that lists R in `overrides` (any
 * family, any effect) evaluates true. Overrides are one level deep: an overrider's own overriders do
 * not matter here. In Kleene terms R is in force with truth `R ∧ ¬(O₁ ∨ … ∨ Oₙ)`, so:
 *   - an overrider that is true suppresses R, even if R itself is unknown;
 *   - an overrider that is unknown does NOT suppress R (safety first). If R is true, R's force is
 *     unknown, and the overrider's missing features are reported. This never yields `allow` (a
 *     guardrail is not lifted on missing information) and never yields `forbid`. A `forbid` is
 *     therefore final: filling in unknown features can never turn it into anything else.
 *
 * Precedence, over the participating rules' force:
 *   1. any forbid true                 → `forbid`
 *   2. else any forbid unknown         → `insufficient_information`
 *   3. else any require_approval true  → `needs_approval`
 *   4. else any require_approval unknown → `insufficient_information`
 *   5. else                            → `allow`
 * `matchedRules`: sorted ids of the rules in the deciding group. `missingFeatures`: for
 * `insufficient_information`, the sorted union of features those rules' force depends on (supplying
 * them all yields a boolean), else empty. `evidence`: the supporting expert quotes of the matched
 * rules. `allow` has all three empty.
 *
 * Throws `RulebookError` if a rule does not type-check against the domain or references an unknown
 * family or action, and `RangeError` if `action` is not a domain action (callers validate input).
 */
export function checkAction({ rules, features, action, domain }: CheckActionInput): GuardrailResult {
  assertRulebook(rules, domain);
  if (!domain.actions.some((a) => a.id === action)) throw new RangeError(`unknown action "${action}" in domain "${domain.id}"`);

  const familiesOfAction = new Set(domain.decisionFamilies.filter((f) => f.actions.includes(action)).map((f) => f.id));
  const overriders = new Map<string, Predicate[]>();
  for (const r of rules)
    for (const id of r.overrides) overriders.set(id, [...(overriders.get(id) ?? []), r.predicate]);

  const forbids: Participant[] = [];
  const approvals: Participant[] = [];
  for (const rule of rules) {
    const group =
      rule.effect.type === "forbid" && rule.effect.action === action
        ? forbids
        : rule.effect.type === "require_approval" && guardsApproval(rule.effect, rule.decisionFamily, action, familiesOfAction)
          ? approvals
          : undefined;
    if (group === undefined) continue;
    group.push({ rule, evaluation: evaluatePredicate(inForce(rule.predicate, overriders.get(rule.id) ?? []), features) });
  }

  return decide(forbids, "forbid") ?? decide(approvals, "needs_approval") ?? { decision: "allow", matchedRules: [], missingFeatures: [], evidence: [] };
}

/**
 * Whether a `require_approval` rule gates `action` (live bug #4). A rule that records the action it
 * guards (`effect.action`, the action the expert's sign-off is for) fires only for that action — so
 * escalating or rejecting a PEP is not held by "approving a PEP needs sign-off". A rule stated before
 * the action was recorded gates every action of its decision family, as it always did (never weaker).
 */
function guardsApproval(
  effect: Extract<ConfirmedRule["effect"], { type: "require_approval" }>,
  decisionFamily: string,
  action: ActionId,
  familiesOfAction: ReadonlySet<string>,
): boolean {
  return effect.action === undefined ? familiesOfAction.has(decisionFamily) : effect.action === action;
}

/** `p ∧ ¬(o₁ ∨ … ∨ oₙ)`, or `p` itself when nothing overrides it. */
function inForce(p: Predicate, overriders: readonly Predicate[]): Predicate {
  const [first, ...rest] = overriders;
  return first === undefined ? p : { and: [p, { "!": [{ or: [first, ...rest] }] }] };
}

function decide(group: readonly Participant[], onTrue: GuardrailDecision): GuardrailResult | undefined {
  const fired = group.filter((p) => p.evaluation.truth === true);
  if (fired.length > 0) return result(onTrue, fired, []);
  const open = group.filter((p) => p.evaluation.truth === "unknown");
  if (open.length > 0) return result("insufficient_information", open, open.flatMap((p) => p.evaluation.unknownFeatures));
  return undefined;
}

function result(decision: GuardrailDecision, matched: readonly Participant[], missing: readonly FeatureId[]): GuardrailResult {
  const rules = matched.map((p) => p.rule).sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  return {
    decision,
    matchedRules: rules.map((r) => r.id),
    missingFeatures: sortedUnique(missing),
    evidence: rules.flatMap((r) => r.evidence.filter(isSupportingQuote)),
  };
}

function isSupportingQuote(e: EvidenceLink): e is ExpertQuoteEvidence {
  return e.kind === "expert_quote" && e.relation === "supports";
}

function assertRulebook(rules: readonly ConfirmedRule[], domain: DomainConfig): void {
  const families = new Set<string>(domain.decisionFamilies.map((f) => f.id));
  const actions = new Set<string>(domain.actions.map((a) => a.id));
  const seen = new Set<string>();
  const issues: string[] = [];
  for (const r of rules) {
    if (seen.has(r.id)) issues.push(`rule "${r.id}": duplicate id`);
    seen.add(r.id);
    if (!families.has(r.decisionFamily)) issues.push(`rule "${r.id}": unknown decision family "${r.decisionFamily}"`);
    if ((r.effect.type === "forbid" || r.effect.type === "recommend") && !actions.has(r.effect.action))
      issues.push(`rule "${r.id}": unknown action "${r.effect.action}"`);
    for (const issue of typecheckPredicate(r.predicate, domain.features))
      issues.push(`rule "${r.id}" predicate${issue.path}: ${issue.message}`);
  }
  if (issues.length > 0) throw new RulebookError(domain.id, issues);
}
