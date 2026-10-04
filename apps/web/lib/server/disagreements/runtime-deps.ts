import { engineConfig } from "@vashistha/core";
import { localizeQuestion } from "../interview/llm";
import { getRuntime } from "../runtime";
import type { DisagreementDeps } from "./deps";

/** Engine knobs: the engine's defaults, as the interview uses them (interview/deps.ts). */
const ENGINE_CONFIG = engineConfig();

/** The two-experts handlers' dependencies, from the process runtime (route adapters only). */
export function disagreementDeps(): DisagreementDeps {
  const runtime = getRuntime();
  return {
    ledger: runtime.ledger,
    casedesk: runtime.casedesk,
    interview: runtime.interview,
    engineConfig: ENGINE_CONFIG,
    authorizations: runtime.authorizations,
    rulebook: runtime.rulebookAllModels,
    experts: runtime.experts.directory,
    solver: runtime.experts.solver,
    team: runtime.experts.team,
    localize: (question, language) => localizeQuestion(runtime.claude, question, language, console),
    store: runtime.experts.store,
    now: Date.now,
    log: console,
  };
}
