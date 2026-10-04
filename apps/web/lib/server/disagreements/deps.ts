/**
 * What the two-experts reconciliation flow needs (plan §7.10). Route adapters build it from the process
 * runtime (`disagreementDeps`); tests build it around an in-memory ledger, the real rulebook store and
 * the real solver. Z3 and SQLite arrive as functions from the runtime, so route bundles never load them.
 */
import "server-only";
import type { ConfirmedRule, DomainConfig, EngineConfig, ExpertLanguage, Question, Rulebook, TeamRulebook, Witness } from "@vashistha/core";
import type { Ledger } from "@vashistha/core/server";
import type { AuthorizationStore } from "../authorizations";
import type { CaseDeskStore } from "../casedesk/session";
import type { ExpertRecord } from "../debrief/rulebook-store";
import type { InterviewStore } from "../interview/engine-state";

export type DisagreementWitness = Extract<Witness, { kind: "disagreement" }>;

/** `@vashistha/solver` `findDisagreements` (exhaustive; `limit` caps how many cases are listed). */
export type DisagreementSolver = (query: {
  domain: DomainConfig;
  rulesA: readonly ConfirmedRule[];
  rulesB: readonly ConfirmedRule[];
  experts: readonly [string, string];
  family: string;
  schemaVersion: number;
}) => Promise<DisagreementWitness[]>;

/**
 * Translates a precomputed English question into the expert's language (Sonnet); returns the question
 * unchanged when no model is available or the translation fails (the English text is then spoken).
 */
export type QuestionLocalizer = (question: Question, language: ExpertLanguage) => Promise<Question>;

export type DisagreementDeps = {
  ledger: Ledger;
  casedesk: CaseDeskStore;
  interview: InterviewStore;
  engineConfig: EngineConfig;
  authorizations: Pick<AuthorizationStore, "getContextVersion">;
  /** The global confirmed rulebook (every expert session, every feature model); per-expert views are taken from it. */
  rulebook: () => Rulebook;
  experts: () => ExpertRecord[];
  solver: DisagreementSolver;
  /** The team rulebook (all experts, open disagreements held back): what the interlock, tutor and MCP evaluate. */
  team: () => TeamRulebook;
  localize: QuestionLocalizer;
  /** Tail of the serial reconciliation writes (one chain per process: writes span two experts' sessions). */
  store: { tail: Promise<void> };
  now: () => number;
  log: Pick<Console, "info" | "warn" | "error">;
};
