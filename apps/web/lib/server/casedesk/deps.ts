import { interviewDeps } from "../interview/deps";
import { interviewHooks } from "../interview/orchestrator";
import { getRuntime } from "../runtime";
import { schemaDeps } from "../schema/runtime-deps";
import { withSchemaBackfill } from "../schema/service";
import { tutorDeps } from "../tutor/deps";
import { tutorHooks } from "../tutor/handlers";
import type { CaseDeskDeps } from "./session";

/** The CaseDesk handlers' dependencies, from the process runtime (route adapters only). */
export function caseDeskDeps(): CaseDeskDeps {
  const { ledger, casedesk, rulebook } = getRuntime();
  return { ledger, store: casedesk, rulebook, interview: withSchemaBackfill(interviewHooks(interviewDeps()), schemaDeps()), tutor: tutorHooks(tutorDeps()), now: Date.now, log: console };
}
