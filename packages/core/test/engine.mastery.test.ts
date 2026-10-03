import { describe, expect, it } from "vitest";
import { MASTERY_LEVELS, masteryFromOutcomes, nextMasteryLevel, type MasteryLevel, type TutorOutcome } from "../src";

type Kind = "wrong" | "assisted" | "alone" | "alone@boundary";
const OUTCOME: Record<Kind, Pick<TutorOutcome, "correct" | "assisted" | "atBoundary">> = {
  wrong: { correct: false, assisted: false, atBoundary: false },
  assisted: { correct: true, assisted: true, atBoundary: false },
  alone: { correct: true, assisted: false, atBoundary: false },
  "alone@boundary": { correct: true, assisted: false, atBoundary: true },
};

/** The full transition table: level × outcome → next level. */
const TABLE: Record<MasteryLevel, Record<Kind, MasteryLevel>> = {
  untested: { wrong: "untested", assisted: "assisted", alone: "independent_once", "alone@boundary": "independent_once" },
  assisted: { wrong: "untested", assisted: "assisted", alone: "independent_once", "alone@boundary": "independent_once" },
  independent_once: { wrong: "assisted", assisted: "independent_once", alone: "independent_once", "alone@boundary": "boundary_correct" },
  boundary_correct: { wrong: "independent_once", assisted: "boundary_correct", alone: "mastered", "alone@boundary": "mastered" },
  mastered: { wrong: "boundary_correct", assisted: "mastered", alone: "mastered", "alone@boundary": "mastered" },
};

describe("mastery ladder", () => {
  it.each(MASTERY_LEVELS.flatMap((level) => (Object.keys(OUTCOME) as Kind[]).map((kind) => [level, kind, TABLE[level][kind]] as const)))(
    "%s + %s → %s",
    (level, kind, expected) => {
      expect(nextMasteryLevel(level, OUTCOME[kind])).toBe(expected);
      // A wrong answer at a boundary demotes the same way.
      if (kind === "wrong") expect(nextMasteryLevel(level, { ...OUTCOME.wrong, atBoundary: true })).toBe(expected);
    },
  );

  it("folds outcomes per rule, in order", () => {
    const o = (ruleId: string, kind: Kind): TutorOutcome => ({ ruleId, ...OUTCOME[kind] });
    const levels = masteryFromOutcomes([o("r1", "assisted"), o("r1", "alone"), o("r2", "wrong"), o("r1", "alone@boundary"), o("r1", "alone"), o("r2", "alone")]);
    expect(Object.fromEntries(levels)).toEqual({ r1: "mastered", r2: "independent_once" });
    expect(masteryFromOutcomes([o("r1", "alone"), o("r1", "alone@boundary"), o("r1", "wrong")]).get("r1")).toBe("independent_once");
  });
});
