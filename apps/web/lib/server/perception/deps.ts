import { getRuntime } from "../runtime";
import type { PerceptionDeps } from "./frames";

/** The vision-channel handlers' dependencies, from the process runtime (route adapters only). */
export function perceptionDeps(): PerceptionDeps {
  const { ledger, casedesk, perception, frames } = getRuntime();
  return { ledger, store: casedesk, perception, frames, now: Date.now, log: console };
}
