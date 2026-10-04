/** `POST /api/sessions` and `GET /api/cases?set=[&session=]`. */
import { randomUUID } from "node:crypto";
import type { z } from "zod";
import { ledgerPayloadSchema, type Expert, type SessionOwner } from "@vashistha/core";
import { KYC_DOMAIN, kycCases } from "@vashistha/core/domains/kyc";
import {
  CreateSessionRequestSchema,
  type CreateSessionResponseSchema,
  type ListCasesResponseSchema,
} from "../../contracts/casedesk";
import { startRefusal } from "../../auth/policy";
import type { Account } from "../auth/store";
import { ApiFailure, json, parseOr400, readJson, respond } from "./http";
import { sessionCases } from "./cases";
import { CASEDESK_SCHEMA_VERSION, SERVED_CASE_SETS, loadSession, sessionExpert, type CaseDeskDeps } from "./session";

/** The signed-in account starting a session. */
export type SessionActor = Pick<Account, "id" | "username" | "displayName" | "role">;

/**
 * Creates a ledger session rooted in an `engine` / `session.started` entry, owned by `actor`: 403 when
 * the actor's role may not start this mode on this case set. An expert session's expert IS the actor.
 */
export function handleCreateSession(
  request: Request,
  deps: CaseDeskDeps,
  actor: SessionActor,
  /** The access policy; harnesses that test session mechanics on any mode and set pass a permissive one. */
  refusalFor: typeof startRefusal = startRefusal,
): Promise<Response> {
  return respond(deps.log, async () => {
    const { mode, caseSet, language } = await readJson(request, CreateSessionRequestSchema);
    const served = SERVED_CASE_SETS.safeParse(caseSet);
    if (!served.success) throw new ApiFailure(400, "invalid_case_set", `the ${caseSet} set is reserved for the benchmark`);
    const refusal = refusalFor(actor.role, mode, served.data);
    if (refusal !== undefined) throw new ApiFailure(403, "not_permitted", refusal);
    const expert: Expert | undefined = mode === "expert" ? { id: actor.username, name: actor.displayName, language: language ?? "en" } : undefined;
    const owner: SessionOwner = { userId: actor.id, username: actor.username, role: actor.role };
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
        ...(expert !== undefined && { expert }),
        owner,
      }),
    });
    deps.store.sessions.set(session.id, { mode, caseSet, startedEntryId: started.id, expert: sessionExpert(session.id, mode, expert), owner });
    const body: z.infer<typeof CreateSessionResponseSchema> = {
      sessionId: session.id,
      mode,
      caseSet,
      privacyEpoch: session.privacyEpoch,
      schemaVersion: CASEDESK_SCHEMA_VERSION,
      ...(expert !== undefined && { expert }),
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
