import { engineConfig } from "@vashistha/core";
import { getRuntime } from "../runtime";
import type { InterviewDeps } from "./orchestrator";

/** Engine knobs in force: the engine's defaults (plan §7.3; heuristics, labelled as such on the HUD). */
const ENGINE_CONFIG = engineConfig();

/** The interview handlers' dependencies, from the process runtime (route adapters and CaseDesk deps only). */
export function interviewDeps(): InterviewDeps {
  const { ledger, casedesk, interview, authorizations, claude } = getRuntime();
  return { ledger, casedesk, store: interview, authorizations, claude, config: ENGINE_CONFIG, now: Date.now, log: console };
}
