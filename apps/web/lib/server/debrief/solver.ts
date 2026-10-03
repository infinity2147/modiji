/**
 * Z3 witness search for the debrief (plan §7.5), bound here so that route bundles never load the
 * solver: only `runtime-init.ts` imports this module, and the debrief reaches it through the runtime.
 */
import "server-only";
import { findBoundaries, findConflicts, findUnresolved } from "@vashistha/solver";
import type { ConfirmedRule, DomainConfig, Witness } from "@vashistha/core";

/**
 * Unresolved cells listed per family. The search is exhaustive (an empty result proves there is no
 * such case); the limit only caps how many are listed, and a full page is reported as `truncated`.
 */
export const UNRESOLVED_LIMIT = 50;

export type WitnessSearch = {
  domain: DomainConfig;
  rules: readonly ConfirmedRule[];
  families: readonly string[];
  schemaVersion: number;
};
export type WitnessSearchResult = { witnesses: Witness[]; truncated: boolean };
export type WitnessSolver = (search: WitnessSearch) => Promise<WitnessSearchResult>;

/**
 * Per family: unresolved cells, genuine conflicts, and the "at threshold" boundary case of every
 * numeric threshold of the family's rules (the debrief asks about the threshold itself; the cases
 * just below and above are the tutor's practice cases, P6).
 */
export function createWitnessSolver(): WitnessSolver {
  return async ({ domain, rules, families, schemaVersion }) => {
    const witnesses: Witness[] = [];
    let truncated = false;
    for (const family of families) {
      const unresolved = await findUnresolved({ domain, rules, family, schemaVersion, limit: UNRESOLVED_LIMIT });
      truncated ||= unresolved.length === UNRESOLVED_LIMIT;
      witnesses.push(...unresolved, ...(await findConflicts({ domain, rules, family, schemaVersion })));
      for (const rule of rules.filter((r) => r.decisionFamily === family)) {
        const boundaries = await findBoundaries({ domain, rules, ruleId: rule.id, schemaVersion });
        witnesses.push(...boundaries.filter((w) => w.side === "at"));
      }
    }
    return { witnesses, truncated };
  };
}
