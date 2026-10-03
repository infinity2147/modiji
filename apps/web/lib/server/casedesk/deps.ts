import { getRuntime } from "../runtime";
import type { CaseDeskDeps } from "./session";

/** The CaseDesk handlers' dependencies, from the process runtime (route adapters only). */
export function caseDeskDeps(): CaseDeskDeps {
  const { ledger, casedesk, rulebook } = getRuntime();
  return { ledger, store: casedesk, rulebook, now: Date.now, log: console };
}
