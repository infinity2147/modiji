/**
 * Authorization for route handlers. `server.ts` already refuses unauthenticated requests to protected
 * paths; these guards decide what the authenticated principal may do, on every route, again.
 *
 * A CaseDesk session is the owner's: only the account that started it writes to it (evidence, answers,
 * rule confirmations), and only while its role still permits that kind of session (a demoted expert's
 * words are no longer confirmations). The owner and admins read it; the operator bearer reads it.
 */
import { z } from "zod";
import { IdSchema, type SessionOwner } from "@vashistha/core";
import { SESSION_STARTS } from "../../auth/policy";
import type { SessionMode } from "../../contracts/casedesk";
import { ApiFailure, readJson, respond } from "../casedesk/http";
import { loadSession, type LoadedSession } from "../casedesk/session";
import { getRuntime } from "../runtime";
import type { Account } from "./store";
import { credentialHeaders, principalFrom, type Principal } from "./principal";

export type SessionNeed = "read" | "write";

/** Why `principal` may not `need` a session owned by `owner` in `mode`; undefined when it may. */
export function sessionRefusal(principal: Principal, session: { owner: SessionOwner | undefined; mode: SessionMode }, need: SessionNeed): string | undefined {
  if (principal.kind === "operator") return need === "read" ? undefined : "operator credentials are read-only";
  const { account } = principal;
  const owns = session.owner !== undefined && session.owner.userId === account.id;
  if (need === "read") return owns || account.role === "admin" ? undefined : "this session belongs to another account";
  if (!owns)
    return session.owner === undefined
      ? "this session predates accounts and is read-only"
      : account.role === "admin"
        ? "admins read sessions but never write to another account's session"
        : "this session belongs to another account";
  if (SESSION_STARTS[account.role].mode !== session.mode) return `your ${account.role} role no longer permits writing to a ${session.mode} session`;
  return undefined;
}

/** The request's principal, or 401. */
export function requirePrincipal(request: Request): Principal {
  const runtime = getRuntime();
  const principal = principalFrom(credentialHeaders(request.headers), {
    accounts: runtime.accounts,
    operatorSecret: runtime.env.CUSTOM_LLM_SECRET,
    now: Date.now(),
  });
  if (principal === undefined) throw new ApiFailure(401, "unauthenticated", "sign in first");
  return principal;
}

/** A signed-in account (not the operator bearer), or 401/403. */
export function requireAccount(principal: Principal): Account {
  if (principal.kind !== "user") throw new ApiFailure(403, "forbidden", "this action needs a signed-in account");
  return principal.account;
}

export function forbid(detail: string): never {
  throw new ApiFailure(403, "forbidden", detail);
}

/**
 * Runs `run` for an authenticated principal that `allow` accepts (`allow` returns a refusal reason,
 * or undefined). Refusals become 401/403 bodies.
 */
export function guard(
  request: Request,
  allow: (principal: Principal) => string | undefined,
  run: (principal: Principal) => Response | Promise<Response>,
): Promise<Response> {
  return respond(console, () => {
    const principal = requirePrincipal(request);
    const refusal = allow(principal);
    if (refusal !== undefined) forbid(refusal);
    return run(principal);
  });
}

/** Any authenticated principal. */
export const anyone = (): undefined => undefined;

/** A signed-in account whose role is one of `roles`. */
export function accountWithRole(...roles: Account["role"][]) {
  return (principal: Principal): string | undefined =>
    principal.kind === "user" && roles.includes(principal.account.role) ? undefined : `this needs the ${roles.join(" or ")} role`;
}

/** Runs `run` when the principal may `need` the CaseDesk session `sessionId`: 401, 403 or 404 otherwise. */
export function guardSession(
  request: Request,
  sessionId: unknown,
  need: SessionNeed,
  run: (principal: Principal, loaded: LoadedSession) => Response | Promise<Response>,
): Promise<Response> {
  return respond(console, () => {
    const principal = requirePrincipal(request);
    const runtime = getRuntime();
    const loaded = loadSession({ ledger: runtime.ledger, store: runtime.casedesk }, sessionId);
    const refusal = sessionRefusal(principal, loaded.info, need);
    if (refusal !== undefined) forbid(refusal);
    return run(principal, loaded);
  });
}

const SessionInBody = z.looseObject({ sessionId: IdSchema });

/** `guardSession` for routes that name the session in their JSON body; the handler reads the original body. */
export function guardSessionInBody(
  request: Request,
  need: SessionNeed,
  run: (principal: Principal, loaded: LoadedSession) => Response | Promise<Response>,
): Promise<Response> {
  return respond(console, async () => {
    requirePrincipal(request);
    const { sessionId } = await readJson(request.clone(), SessionInBody);
    return guardSession(request, sessionId, need, run);
  });
}

const PairInBody = z.looseObject({ experts: z.array(z.string()) });
const ExpertInBody = z.looseObject({ expertId: z.string() });

/** Searching two experts' rulebooks queues questions in both: an admin, or one of the two experts. */
export function guardDisagreementSearch(request: Request, run: () => Response | Promise<Response>): Promise<Response> {
  return respond(console, async () => {
    const account = requireAccount(requirePrincipal(request));
    const { experts } = await readJson(request.clone(), PairInBody);
    if (account.role !== "admin" && !(account.role === "expert" && experts.includes(account.username)))
      forbid("only an admin or one of the two experts may search their rulebooks");
    return run();
  });
}

/** An expert answers a disagreement only in their own name. */
export function guardDisagreementAnswer(request: Request, run: () => Response | Promise<Response>): Promise<Response> {
  return respond(console, async () => {
    const account = requireAccount(requirePrincipal(request));
    const { expertId } = await readJson(request.clone(), ExpertInBody);
    if (account.role !== "expert") forbid("only an expert answers a disagreement");
    if (expertId !== account.username) forbid(`you are signed in as ${account.username}; an expert answers only for themselves`);
    return run();
  });
}
