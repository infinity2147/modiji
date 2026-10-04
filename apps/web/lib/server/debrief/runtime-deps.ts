import { engineConfig } from "@vashistha/core";
import { getRuntime } from "../runtime";
import type { DebriefDeps } from "./deps";

/** Engine knobs: the engine's defaults, as the interview uses them (interview/deps.ts). */
const ENGINE_CONFIG = engineConfig();

/** The debrief handlers' dependencies, from the process runtime (route adapters only). */
export function debriefDeps(): DebriefDeps {
  const runtime = getRuntime();
  return {
    ledger: runtime.ledger,
    casedesk: runtime.casedesk,
    interview: runtime.interview,
    engineConfig: ENGINE_CONFIG,
    authorizations: runtime.authorizations,
    rulebook: runtime.rulebookAllModels,
    solver: runtime.debrief.solver,
    claude: runtime.claude,
    models: runtime.debrief.models,
    exports: runtime.debrief.exports,
    store: runtime.debrief.store,
    dataDir: runtime.env.DATA_DIR,
    mcpBearerRequired: runtime.env.MCP_BEARER_TOKEN !== undefined,
    now: Date.now,
    log: console,
  };
}
