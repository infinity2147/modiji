import { z } from "zod";
import { ActionIdSchema, SymbolIdSchema } from "../schemas/primitives";

/**
 * Hypothesis-engine knobs (plan §7.3). Every number here is a heuristic unless calibrated on
 * Apprentice-Bench; the HUD labels it as such.
 */
export const EngineConfigSchema = z.strictObject({
  /** Prior ∝ exp(−λ·complexity). */
  lambda: z.number().nonnegative().default(1),
  /** ε in P(a|h) = 1−ε if h predicts a, else ε/(|A|−1). */
  expertNoisePrior: z.number().gt(0).lt(1).default(0.05),
  /** Largest conjunction the enumerator builds (3 is opt-in: the space grows quickly). */
  maxConditions: z.union([z.literal(2), z.literal(3)]).default(2),
  /** Hard bound on enumerated candidates per family; the simplest are kept (complexity, then id). */
  maxCandidates: z.int().positive().default(5000),
  /** Domain-meaningful round thresholds kept per observed decision boundary (besides its midpoint). */
  roundThresholdsPerBoundary: z.int().nonnegative().default(3),
  /**
   * Prior multiplier for candidates the expert stated. Heuristic: the statement itself is evidence
   * that a plain enumerated hypothesis does not have.
   */
  statedRulePriorMultiplier: z.number().positive().default(10),
  /**
   * Per family, the action a hypothesis predicts when its predicate is false
   * ("if p then a else default"). Defaults to the family's first action.
   */
  defaultActions: z.record(SymbolIdSchema, ActionIdSchema).default({}),
  /** A decision this surprising (bits) is reported as "contradiction detected". 3 bits ⇔ P(a) < 1/8. */
  contradictionBits: z.number().nonnegative().default(3),
  /** A decision is "explained" when candidates predicting it hold at least this posterior mass. */
  explainedMass: z.number().gt(0).max(1).default(0.5),
  /** Parsed answers below this confidence are not applied (the question stays open). */
  minParseConfidence: z.number().min(0).max(1).default(0.5),
  /** Queue priority (not EIG: an undefined concept has no hypothesis space yet) of a concept-definition probe. */
  conceptProbeValue: z.number().nonnegative().default(0.75),
});
export type EngineConfig = z.output<typeof EngineConfigSchema>;
export type EngineConfigInput = z.input<typeof EngineConfigSchema>;

export function engineConfig(input: EngineConfigInput = {}): EngineConfig {
  return EngineConfigSchema.parse(input);
}

/** Live questions are spoken during work: at most this many words (plan §7.2). */
export const MAX_QUESTION_WORDS = 25;
