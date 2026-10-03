/** The CaseDesk session lives in the URL (`/sandbox?session=…&set=…&mode=…`) so a reload resumes it. */
import { IdSchema } from "@vashistha/core";
import { CaseSetSchema, type CaseSet } from "@vashistha/core/domains/kyc";
import { SessionModeSchema, type SessionMode } from "../contracts/casedesk";

export type SessionRef = { sessionId: string; caseSet: CaseSet; mode: SessionMode };

type Params = { get: (name: string) => string | null };

/** `undefined` when no session is named; `"invalid"` when the parameters are present but malformed. */
export function parseSessionParams(params: Params): SessionRef | "invalid" | undefined {
  const session = params.get("session");
  if (session === null) return undefined;
  const sessionId = IdSchema.safeParse(session);
  const caseSet = CaseSetSchema.safeParse(params.get("set"));
  const mode = SessionModeSchema.safeParse(params.get("mode"));
  if (!sessionId.success || !caseSet.success || !mode.success) return "invalid";
  return { sessionId: sessionId.data, caseSet: caseSet.data, mode: mode.data };
}

export function sessionHref(ref: SessionRef): string {
  const query = new URLSearchParams({ session: ref.sessionId, set: ref.caseSet, mode: ref.mode });
  return `/sandbox?${query.toString()}`;
}
