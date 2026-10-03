import { z } from "zod";
import { IdSchema } from "../schemas/primitives";
import { MASTERY_LEVELS, type MasteryLevel } from "../schemas/engine";

/** One tutor outcome on one rule: was the novice right, did they need help, was the case at the rule's boundary? */
export const TutorOutcomeSchema = z.strictObject({
  ruleId: IdSchema,
  correct: z.boolean(),
  assisted: z.boolean(),
  atBoundary: z.boolean(),
});
export type TutorOutcome = z.infer<typeof TutorOutcomeSchema>;

/**
 * The transparent mastery ladder (plan §7.7):
 *   untested → assisted → independent_once → boundary_correct → mastered.
 * One outcome moves at most one rung:
 *   - wrong: down one rung (floor: untested). A slip costs the last rung, not the whole history;
 *   - correct with help: untested → assisted; never moves a higher level (help proves nothing new);
 *   - correct alone: untested/assisted → independent_once; independent_once → boundary_correct
 *     only on a boundary case; boundary_correct → mastered on any further independent success.
 * Deterministic, no hidden state, no probabilities (BKT would be labelled "heuristic estimate").
 */
export function nextMasteryLevel(level: MasteryLevel, outcome: Pick<TutorOutcome, "correct" | "assisted" | "atBoundary">): MasteryLevel {
  const rung = MASTERY_LEVELS.indexOf(level);
  if (!outcome.correct) return MASTERY_LEVELS[Math.max(0, rung - 1)] ?? "untested";
  if (outcome.assisted) return level === "untested" ? "assisted" : level;
  switch (level) {
    case "untested":
    case "assisted":
      return "independent_once";
    case "independent_once":
      return outcome.atBoundary ? "boundary_correct" : level;
    case "boundary_correct":
    case "mastered":
      return "mastered";
  }
}

/** Folds outcomes (in order) into each rule's level; rules without outcomes are absent (= untested). */
export function masteryFromOutcomes(outcomes: readonly TutorOutcome[]): Map<string, MasteryLevel> {
  const levels = new Map<string, MasteryLevel>();
  for (const o of outcomes) levels.set(o.ruleId, nextMasteryLevel(levels.get(o.ruleId) ?? "untested", o));
  return levels;
}
