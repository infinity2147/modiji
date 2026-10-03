/** `GET /api/sessions/:sessionId/ledger?after=&limit=`: a page of the session's ledger, every source labelled. */
import type { z } from "zod";
import { LedgerPageQuerySchema, type LedgerPageResponseSchema } from "../../contracts/ledger";
import { json, parseOr400, respond } from "./http";
import { loadSession, type CaseDeskDeps } from "./session";

export function handleLedgerPage(request: Request, sessionId: string, deps: CaseDeskDeps): Promise<Response> {
  return respond(deps.log, () => {
    const query = parseOr400(
      LedgerPageQuerySchema,
      Object.fromEntries(new URL(request.url).searchParams),
      "invalid_query",
    );
    const { session } = loadSession(deps, sessionId);
    const entries = deps.ledger.list(session.id, {
      limit: query.limit,
      ...(query.after !== undefined && { afterSequence: query.after }),
    });
    const body: z.infer<typeof LedgerPageResponseSchema> = { entries };
    return json(body);
  });
}
