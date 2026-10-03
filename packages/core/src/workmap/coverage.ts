/**
 * The stop criterion "Coverage under current model" (plan §7.5): observed decisions explained N/N ·
 * unresolved witnesses 0 (or explicitly marked by the expert) · undefined concepts 0 · teach-back
 * confirmed. Computed by code from the rulebook and the current solver witnesses; `closed` — and with
 * it the sentence "No unresolved counterexample exists under the current feature model." — holds
 * only when all four do, over at least one observed decision (an empty session proves nothing).
 */
import type { DomainConfig } from "../schemas/domain";
import type { Witness, WitnessResolution } from "../schemas/engine";
import type { ConfirmedRule } from "../schemas/rules";
import { CoverageSchema, type Coverage } from "../schemas/workmap";
import { explainObserved, type ObservedDecision } from "./build";
import { sameDecisionCell } from "./semantics";

/** Witness kinds that block coverage. Boundary witnesses are checks of a rule's threshold, not gaps. */
export const GAP_WITNESS_KINDS: readonly Witness["kind"][] = ["unresolved", "conflict"];

/** Resolutions by which the expert acknowledges a gap without adding a rule. */
export const ACKNOWLEDGING_RESOLUTIONS: readonly WitnessResolution["resolution"][] = ["escalate_to_controller", "out_of_scope"];

export type AcknowledgedWitness = { witness: Witness; resolution: WitnessResolution };

/**
 * The acknowledgement covering a current witness, if any: one recorded for this witness id, or for
 * an earlier witness of the same kind and family whose case lies in the same decision cell under the
 * current rulebook (the rulebook cannot tell the two cases apart, so the expert's answer applies to
 * both; a solver rerun after an unrelated rule change re-finds the cell under a new canonical case).
 */
export function acknowledgementFor(input: {
  domain: DomainConfig;
  rules: readonly ConfirmedRule[];
  witness: Witness;
  acknowledged: readonly AcknowledgedWitness[];
}): AcknowledgedWitness | undefined {
  const { domain, rules, witness } = input;
  const family = domain.decisionFamilies.find((f) => f.id === witness.decisionFamily);
  return input.acknowledged.find(
    (a) =>
      ACKNOWLEDGING_RESOLUTIONS.includes(a.resolution.resolution) &&
      (a.witness.id === witness.id ||
        (family !== undefined &&
          a.witness.kind === witness.kind &&
          a.witness.decisionFamily === witness.decisionFamily &&
          sameDecisionCell(rules, family, a.witness.assignment, witness.assignment))),
  );
}

export type CoverageInput = {
  domain: DomainConfig;
  rules: readonly ConfirmedRule[];
  /** Observed decisions of the expert session(s). */
  decisions: readonly ObservedDecision[];
  /** Witnesses the solver finds now, under `rules`. */
  witnesses: readonly Witness[];
  /** Every witness the expert acknowledged (escalate to controller / out of scope), as it was found. */
  resolutions: readonly AcknowledgedWitness[];
  undefinedConcepts: number;
  teachBackConfirmed: boolean;
  schemaVersion: number;
};

export function computeCoverage(input: CoverageInput): Coverage {
  const { domain, rules } = input;
  const explained = input.decisions.filter((d) => explainObserved(domain, rules, d).explained).length;
  const total = input.decisions.length;
  const gaps = input.witnesses.filter((w) => GAP_WITNESS_KINDS.includes(w.kind));
  const acknowledged = gaps.filter((w) => acknowledgementFor({ domain, rules, witness: w, acknowledged: input.resolutions }) !== undefined).length;
  const unresolved = gaps.length - acknowledged;
  return CoverageSchema.parse({
    decisionsExplained: { explained, total },
    unresolvedWitnesses: unresolved,
    acknowledgedWitnesses: acknowledged,
    undefinedConcepts: input.undefinedConcepts,
    teachBackConfirmed: input.teachBackConfirmed,
    schemaVersion: input.schemaVersion,
    closed: total > 0 && explained === total && unresolved === 0 && input.undefinedConcepts === 0 && input.teachBackConfirmed,
  });
}
