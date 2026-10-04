import { engineConfig } from "@vashistha/core";
import { getRuntime } from "../runtime";
import type { SchemaDeps } from "./deps";

/** Engine knobs: the engine's defaults, as the interview uses them (interview/deps.ts). */
const ENGINE_CONFIG = engineConfig();

/** The schema-versioning handlers' dependencies, from the process runtime (route adapters and CaseDesk deps only). */
export function schemaDeps(): SchemaDeps {
  const { ledger, casedesk, interview, schema } = getRuntime();
  return { ledger, casedesk, interview, engineConfig: ENGINE_CONFIG, reread: schema.reread, store: schema.store, now: Date.now, log: console };
}
