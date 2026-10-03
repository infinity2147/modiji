/**
 * The mastery ladder per novice session and rule (plan §7.7): untested → assisted → independently
 * correct once → correct at a boundary case → mastered, moved by the engine's `nextMasteryLevel`.
 * A transparent heuristic estimate, not a calibrated model. Every rung that changes is a
 * `mastery.updated` entry whose parents are the tutor event that moved it and the rule's own entry.
 *
 * Tutor outcomes, per rule:
 *   - prediction: correct or wrong, unassisted, for each rule deciding the expected outcome;
 *   - intervention (guardrail violation sensed): wrong, for each stop-rule the selection broke;
 *   - commit, decision rules: counted unless a correct prediction already credited the same
 *     answer; assisted when the reveal (a wrong prediction) or an intervention preceded it;
 *   - commit, stop-rules firing on the case: correct when the committed outcome is not the one they
 *     forbid; assisted when the tutor had to intervene on that rule for this case.
 * Outcomes on a solver boundary practice case count as "at a boundary".
 */
import "server-only";
import { nextMasteryLevel, ruleFires, type ActionId, type ConfirmedRule, type LedgerEntry, type MasteryLevel, type TutorOutcome } from "@vashistha/core";
import type { KycCase } from "@vashistha/core/domains/kyc";
import { entry, type EntryContext } from "../interview/ledger";
import type { TutorDeps } from "./deps";
import type { Expected } from "./predict";
import { caseLookup, type ReviewEdits } from "./session";

export function predictionOutcomes(ruleIds: readonly string[], correct: boolean, atBoundary: boolean): TutorOutcome[] {
  return ruleIds.map((ruleId) => ({ ruleId, correct, assisted: false, atBoundary }));
}

export function interventionOutcomes(ruleIds: readonly string[], atBoundary: boolean): TutorOutcome[] {
  return ruleIds.map((ruleId) => ({ ruleId, correct: false, assisted: false, atBoundary }));
}

export function commitOutcomes(input: {
  action: ActionId;
  expected: Expected;
  /** The case's prediction, if one was made. */
  prediction: { correct: boolean } | undefined;
  /** Stop-rules the tutor intervened on for this case. */
  intervened: ReadonlySet<string>;
  rules: readonly ConfirmedRule[];
  kycCase: KycCase;
  edits: ReviewEdits;
  atBoundary: boolean;
}): TutorOutcome[] {
  const { action, expected, prediction, intervened, atBoundary } = input;
  const out: TutorOutcome[] = [];
  if (expected.kind === "decided") {
    const correct = action === expected.action;
    if (!(prediction?.correct === true && correct)) {
      const assisted = prediction === undefined ? intervened.size > 0 : !prediction.correct;
      for (const ruleId of expected.ruleIds) out.push({ ruleId, correct, assisted, atBoundary });
    }
  }
  const lookup = caseLookup(input.kycCase, input.edits);
  for (const rule of input.rules) {
    if (rule.effect.type !== "forbid" || ruleFires(rule, input.rules, lookup) !== true) continue;
    out.push({ ruleId: rule.id, correct: action !== rule.effect.action, assisted: intervened.has(rule.id), atBoundary });
  }
  return out;
}

/**
 * Moves the session's ladder by `outcomes` (in order) and appends a `mastery.updated` for every rule
 * whose rung changed. `levels` is the session's current ladder; it is updated in place.
 */
export function recordOutcomes(
  deps: Pick<TutorDeps, "ledger">,
  ctx: EntryContext,
  input: { levels: Map<string, MasteryLevel>; outcomes: readonly TutorOutcome[]; trigger: string; ruleEntries: ReadonlyMap<string, string> },
): LedgerEntry[] {
  const before = new Map(input.levels);
  for (const o of input.outcomes) input.levels.set(o.ruleId, nextMasteryLevel(input.levels.get(o.ruleId) ?? "untested", o));
  const changed = [...new Set(input.outcomes.map((o) => o.ruleId))].flatMap((ruleId) => {
    const from = before.get(ruleId) ?? "untested";
    const to = input.levels.get(ruleId) ?? "untested";
    if (from === to) return [];
    const parents = [input.trigger, input.ruleEntries.get(ruleId)].filter((p): p is string => p !== undefined);
    return [entry(ctx, "mastery.updated", "engine", parents, { ruleId, from, to })];
  });
  return deps.ledger.appendMany(changed);
}
