/**
 * The ONLY ground truth of the bench: NSRP-1, the deterministic hidden-policy program (plan §9).
 * Imported by the simulated expert (the question channel) and by the metrics — never by the learner
 * or the strategies (a test enforces this).
 */
import { recordLookup, type ActionId, type Assignment } from "@vashistha/core";
import { KYC_HIDDEN_POLICY, type OracleResult, type OracleRule } from "@vashistha/core/domains/kyc/oracle";
import { FAMILY_ID } from "./domain";

const ORACLE = KYC_HIDDEN_POLICY;

/** The oracle rules of the bench family, in the oracle's order (priority desc, then id). */
export const FAMILY_RULES: readonly OracleRule[] = ORACLE.rules.filter((r) => r.decisionFamily === FAMILY_ID);

export type { OracleRule };

export type OracleVerdict = { action: ActionId; firedRuleIds: string[] };

export function oracleVerdict(features: Assignment): OracleVerdict {
  const result: OracleResult = ORACLE.evaluate(recordLookup(features));
  const decision = result.decisions[FAMILY_ID];
  if (decision === undefined) throw new Error(`oracle returned no ${FAMILY_ID} decision`);
  return { action: decision.action, firedRuleIds: decision.firedRuleIds };
}
