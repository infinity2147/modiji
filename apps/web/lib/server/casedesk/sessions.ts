/** `POST /api/sessions` and `GET /api/cases?set=[&session=]`. */
import { randomUUID } from "node:crypto";
import type { z } from "zod";
import { ledgerPayloadSchema } from "@vashistha/core";
import { KYC_DOMAIN, kycCases } from "@vashistha/core/domains/kyc";
import {
  CreateSessionRequestSchema,
  type CreateSessionResponseSchema,
  type ListCasesResponseSchema,
} from "../../contracts/casedesk";
import { ApiFailure, json, parseOr400, readJson, respond } from "./http";
import { sessionCases } from "./cases";
import { CASEDESK_SCHEMA_VERSION, SERVED_CASE_SETS, loadSession, type CaseDeskDeps } from "./session";

/** Creates a ledger session rooted in an `engine` / `session.started` entry. */
export function handleCreateSession(request: Request, deps: CaseDeskDeps): Promise<Response> {
  return respond(deps.log, async () => {
    const { mode, caseSet } = await readJson(request, CreateSessionRequestSchema);
    if (!SERVED_CASE_SETS.safeParse(caseSet).success)
      throw new ApiFailure(400, "invalid_case_set", `the ${caseSet} set is reserved for the benchmark`);
    const session = deps.ledger.createSession();
    const started = deps.ledger.append({
      sessionId: session.id,
      source: "engine",
      kind: "session.started",
      occurredAt: deps.now(),
      traceId: randomUUID(),
      parentIds: [],
      schemaVersion: CASEDESK_SCHEMA_VERSION,
      privacyEpoch: session.privacyEpoch,
      payload: ledgerPayloadSchema("session.started").parse({
        mode,
        caseSet,
        domainId: KYC_DOMAIN.id,
        schemaVersion: CASEDESK_SCHEMA_VERSION,
      }),
    });
    deps.store.sessions.set(session.id, { mode, caseSet, startedEntryId: started.id });
    const body: z.infer<typeof CreateSessionResponseSchema> = {
      sessionId: session.id,
      mode,
      caseSet,
      privacyEpoch: session.privacyEpoch,
      schemaVersion: CASEDESK_SCHEMA_VERSION,
    };
    return json(body, 201);
  });
}

/**
 * Public case data of one served set; 400 for a missing, unknown or benchmark-only set. With
 * `session=<id>` (a session working that set), the session's generated cases follow the set's.
 */
export function handleListCases(request: Request, deps: Pick<CaseDeskDeps, "log" | "ledger" | "store">): Promise<Response> {
  return respond(deps.log, () => {
    const params = new URL(request.url).searchParams;
    const set = parseOr400(SERVED_CASE_SETS, params.get("set"), "invalid_case_set");
    const sessionId = params.get("session");
    let cases = kycCases(set);
    if (sessionId !== null) {
      const { info, session } = loadSession(deps, sessionId);
      if (info.caseSet !== set) throw new ApiFailure(400, "invalid_case_set", `session ${session.id} works the ${info.caseSet} set`);
      cases = sessionCases(deps.ledger, session.id, info);
    }
    const body: z.infer<typeof ListCasesResponseSchema> = { cases };
    return json(body);
  });
}
