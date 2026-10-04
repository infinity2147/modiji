import { evaluatePredicate } from "../logic/evaluate";
import { recordLookup } from "./model";
import type { Assignment } from "../schemas/engine";
import type { ConfirmedRule } from "../schemas/rules";
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
 */
export type DisagreementHold = {
  witnessId: string;
  decisionFamily: string;
  experts: readonly [string, string];
  assignment: Assignment;
};

export type TeamRulebook = Rulebook & { held: { ruleId: string; witnessId: string }[] };

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
  const rules = book.rules.filter((rule) => {
    const hold = holds.find((h) => heldBy(rule, h));
    if (hold !== undefined) held.push({ ruleId: rule.id, witnessId: hold.witnessId });
    return hold === undefined;
  });
  return { ...book, rules, held };
}
