/**
 * Z3 disagreement search (plan §7.10), bound here so that route bundles never load the solver: only
 * `runtime-init.ts` imports this module, and the reconciliation flow reaches it through the runtime.
 */
import "server-only";
import { findDisagreements } from "@vashistha/solver";
import type { DisagreementSolver } from "./deps";

export function createDisagreementSolver(): DisagreementSolver {
  return ({ domain, rulesA, rulesB, experts, family, schemaVersion }) => findDisagreements({ domain, rulesA, rulesB, experts, family, schemaVersion });
}
