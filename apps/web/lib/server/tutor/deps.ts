/**
 * What the tutor needs. Route adapters build it from the process runtime (`tutorDeps`); tests build it
 * around an in-memory ledger, the real rulebook store and the real solver. Z3 arrives as a function
 * from the runtime, so route bundles never load it (see runtime.ts).
 */
import "server-only";
import type { ConfirmedRule, DomainConfig, Rulebook, Witness } from "@vashistha/core";
import type { Ledger } from "@vashistha/core/server";
import type { ContrastWitness, PracticeWitness } from "@vashistha/solver";
import type { AuthorizationStore } from "../authorizations";
import type { CaseDeskStore } from "../casedesk/session";
import { getRuntime } from "../runtime";

export type BoundaryWitness = Extract<Witness, { kind: "boundary" }>;
export type { ContrastWitness, PracticeWitness };

/**
 * `@vashistha/solver` `practiceCases`: per rule of `ruleIds` (weakest first) its boundary cases, then its
 * contrast cases (a condition pivotal, the rule firing or just missing), round-robin, at most `count`.
 */
export type PracticeSolver = (query: {
  domain: DomainConfig;
  rules: readonly ConfirmedRule[];
  ruleIds: readonly string[];
  count: number;
  schemaVersion: number;
}) => Promise<PracticeWitness[]>;

export type TutorDeps = {
  ledger: Ledger;
  casedesk: CaseDeskStore;
  /** The expert's confirmed rulebook in force (all expert sessions). The tutor never reads anything else to judge. */
  rulebook: () => Pick<Rulebook, "rules" | "revision" | "history">;
  authorizations: Pick<AuthorizationStore, "getContextVersion">;
  /** The display name of an account (for the coach's spoken welcome); absent in tests that do not need it. */
  displayName?: (userId: string) => string | undefined;
  practice: PracticeSolver;
  now: () => number;
  log: Pick<Console, "info" | "warn" | "error">;
};

/** The tutor's dependencies, from the process runtime (route adapters and CaseDesk deps only). */
export function tutorDeps(): TutorDeps {
  const runtime = getRuntime();
  return {
    ledger: runtime.ledger,
    casedesk: runtime.casedesk,
    rulebook: runtime.rulebookState,
    authorizations: runtime.authorizations,
    displayName: (userId) => runtime.accounts.byId(userId)?.displayName,
    practice: runtime.tutor.practice,
    now: Date.now,
    log: console,
  };
}
