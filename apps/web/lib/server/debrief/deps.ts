/**
 * What the debrief handlers need. Route adapters build it from the process runtime (`debriefDeps`);
 * tests build it around an in-memory ledger, a fake Claude and the real solver. Everything heavy
 * (Z3, SQLite, the MCP/export package) arrives as a function from the runtime, so route bundles stay
 * free of it (see runtime.ts).
 */
import "server-only";
import type { ConfirmedRule, DomainConfig, EngineConfig, Rulebook, WorkMap } from "@vashistha/core";
import type { Claude, ClaudeModel, Ledger } from "@vashistha/core/server";
import type { AuthorizationStore } from "../authorizations";
import type { CaseDeskStore } from "../casedesk/session";
import type { InterviewStore } from "../interview/engine-state";
import type { WitnessSearchResult, WitnessSolver } from "./solver";

/** Deterministic exports (`@vashistha/mcp-guardrails`), injected by the composition root. */
export type DebriefExports = {
  workMapJson: (workMap: WorkMap) => string;
  procedure: (input: { domain: DomainConfig; rules: readonly ConfirmedRule[]; revision: number }) => string;
};

/** Model routing for the debrief's non-authoritative prose (plan §5): teach-back, step titles, summary. */
export type DebriefModels = { prose: ClaudeModel };

/** Per-process caches; the ledger stays the source of truth. */
export type DebriefStore = {
  /** Solver results by rulebook revision, families and schema version. */
  witnesses: Map<string, Promise<WitnessSearchResult>>;
  /** Work Map prose by Work Map id (titles and summary are written once per Work Map). */
  prose: Map<string, { titles: Record<string, string>; summary: string; origin: "llm" | "template" }>;
  /** Tail of each session's serial debrief writes. */
  tails: Map<string, Promise<void>>;
};

export function createDebriefStore(): DebriefStore {
  return { witnesses: new Map(), prose: new Map(), tails: new Map() };
}

export type DebriefDeps = {
  ledger: Ledger;
  casedesk: CaseDeskStore;
  /** The interview engine's derived state (hypotheses, question statuses, utterances, concepts). */
  interview: InterviewStore;
  engineConfig: EngineConfig;
  authorizations: Pick<AuthorizationStore, "getContextVersion">;
  /** The confirmed rulebook in force (all expert sessions). */
  rulebook: () => Rulebook;
  solver: WitnessSolver;
  /** Null when ANTHROPIC_API_KEY is not set: prose falls back to labelled templates. */
  claude: Claude | null;
  models: DebriefModels;
  exports: DebriefExports;
  store: DebriefStore;
  dataDir: string;
  /** `/mcp` requires a bearer token (MCP_BEARER_TOKEN is set). */
  mcpBearerRequired: boolean;
  now: () => number;
  log: Pick<Console, "info" | "warn" | "error">;
};
