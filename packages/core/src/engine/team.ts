import { evaluatePredicate } from "../logic/evaluate";
import { recordLookup } from "./model";
import type { Assignment } from "../schemas/engine";
import type { ConfirmedRule } from "../schemas/rules";
import { canonicalJson } from "./canonical";
import { absorb, ruleIdentity } from "./dedupe";
import { ruleExperts, type Rulebook } from "./rulebook";

/**
 * Team rulebook with two or more experts (plan §7.10). The interlock, tutor and MCP `check_action`
 * evaluate ONE rulebook: every rule confirmed by any expert, except that while a disagreement between
 * two experts is open on a decision family, the disagreeing DECISION rules are held back.
 *
 * Held back: a rule of the disagreement's family whose effect is a decision (`recommend` or `route`),
 * that belongs to one of the two experts (`ruleExperts`), and whose predicate is not false on the
 * disagreement case (true or unknown there). Never held back: `forbid` and `require_approval` rules —
 * a guardrail from either expert stays in force whatever the disagreement.
 *
 * Safety is monotonic. `checkAction` lets only guardrails constrain an action, and a held-back decision
 * rule can affect a guardrail only by overriding it (`overrides`). Removing an overrider can only make
 * the guardrail's force `p ∧ ¬(o₁ ∨ …)` truer, so for every case and action the team rulebook with a
 * disagreement open is at least as restrictive as without it: a disagreement never removes a forbid,
 * never lifts a sign-off, and never turns `insufficient_information` into `allow`. The tutor, which
 * explains decisions from decision rules, says nothing about the held-back case instead of taking a side.
 *
 * A disagreement is open from its `witness.found` until its `witness.resolved`; the rulebook revision
 * counts rule events only, so a hold shows up in `held`, not in the revision.
 *
 * Semantically identical rules are merged in the team view (`merged`): two experts who each confirmed
 * the same rule (`ruleIdentity`: decision family, canonical predicate, effect) appear once, as the
 * earlier rule carrying both experts' confirmations and evidence (`absorb`). Only rules that also have
 * the same override edges in both directions (what they override, and which rules override them) are
 * merged, so the merge changes no decision: every check over the team rulebook gives the same result,
 * citing one rule with both experts' quotes instead of two. Per-expert rulebooks keep both rules.
 */
export type DisagreementHold = {
  witnessId: string;
  decisionFamily: string;
  experts: readonly [string, string];
  assignment: Assignment;
};

export type TeamRulebook = Rulebook & {
  held: { ruleId: string; witnessId: string }[];
  /** Rules shown as part of an identical earlier rule (`into`), whose confirmations and evidence it carries. */
  merged: { ruleId: string; into: string }[];
};

function isDecisionRule(rule: ConfirmedRule): boolean {
  return rule.effect.type === "recommend" || rule.effect.type === "route";
}

/** Whether `rule` is held back by `hold` (see the module comment). */
export function heldBy(rule: ConfirmedRule, hold: DisagreementHold): boolean {
  if (rule.decisionFamily !== hold.decisionFamily || !isDecisionRule(rule)) return false;
  if (!ruleExperts(rule).some((e) => hold.experts.includes(e))) return false;
  return evaluatePredicate(rule.predicate, recordLookup(hold.assignment)).truth !== false;
}

export function teamRulebook(book: Rulebook, holds: readonly DisagreementHold[]): TeamRulebook {
  const held: TeamRulebook["held"] = [];
  const inForce = book.rules.filter((rule) => {
    const hold = holds.find((h) => heldBy(rule, h));
    if (hold !== undefined) held.push({ ruleId: rule.id, witnessId: hold.witnessId });
    return hold === undefined;
  });
  const { rules, merged } = mergeIdentical(inForce);
  return { ...book, rules, held, merged };
}

/** Folds each rule into the first earlier rule with the same identity and the same override edges (see the module comment). */
function mergeIdentical(rules: readonly ConfirmedRule[]): { rules: ConfirmedRule[]; merged: TeamRulebook["merged"] } {
  const overriddenBy = new Map<string, string[]>();
  for (const r of rules) for (const id of r.overrides) overriddenBy.set(id, [...(overriddenBy.get(id) ?? []), r.id]);
  const signature = (r: ConfirmedRule): string =>
    canonicalJson([ruleIdentity(r), [...r.overrides].sort(), [...(overriddenBy.get(r.id) ?? [])].sort()]);
  const kept = new Map<string, ConfirmedRule>();
  const merged: TeamRulebook["merged"] = [];
  for (const rule of rules) {
    const key = signature(rule);
    const into = kept.get(key);
    if (into === undefined) kept.set(key, rule);
    else {
      // Shown at its own revision: the team view adds the other expert's confirmations and quotes, it records nothing.
      kept.set(key, { ...(absorb(into, rule) ?? into), revision: into.revision });
      merged.push({ ruleId: rule.id, into: into.id });
    }
  }
  return { rules: [...kept.values()], merged };
}
