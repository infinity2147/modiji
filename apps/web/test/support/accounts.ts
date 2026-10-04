/**
 * Session owners for handler-level harnesses. They test CaseDesk mechanics on every mode and case set,
 * so they create sessions under `PERMIT_ALL`; the real policy has its own tests (auth-policy.test.ts).
 */
import { randomUUID } from "node:crypto";
import { expertIdFromName } from "@vashistha/core";
import type { SessionActor } from "../../lib/server/casedesk/sessions";

export const PERMIT_ALL = (): undefined => undefined;

let unnamed = 0;

/**
 * The account starting a `mode` session. A named expert is the account of that name (sessions of one
 * name share a rulebook); an unnamed one gets an account of its own, as an unnamed session used to.
 */
export function harnessActor(mode: unknown, expertName?: string): SessionActor {
  if (mode !== "expert") return { id: randomUUID(), username: `trainee-${++unnamed}`, displayName: "Trainee", role: "trainee" };
  const username = (expertName === undefined ? undefined : expertIdFromName(expertName)) ?? `expert-${++unnamed}`;
  return { id: `account-${username}`, username, displayName: expertName ?? "Expert", role: "expert" };
}

/** `{ mode, caseSet, expert: { name, language } }` (the pre-accounts body) → the actor and the request body. */
export function harnessSessionRequest(body: unknown): { actor: SessionActor; body: unknown } {
  if (typeof body !== "object" || body === null || Array.isArray(body) || !("mode" in body)) return { actor: harnessActor(undefined), body };
  const { expert, ...rest } = body as { mode: unknown; expert?: { name: string; language?: string } };
  return { actor: harnessActor(rest.mode, expert?.name), body: expert?.language === undefined ? rest : { ...rest, language: expert.language } };
}
