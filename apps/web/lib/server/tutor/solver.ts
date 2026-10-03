/**
 * Z3 practice-case search for the tutor (plan §7.7), bound here so that route bundles never load the
 * solver: only `runtime-init.ts` imports this module; the tutor reaches it through the runtime.
 */
import "server-only";
import { practiceCases } from "@vashistha/solver";
import type { PracticeSolver } from "./deps";

export function createPracticeSolver(): PracticeSolver {
  return (query) => practiceCases(query);
}
