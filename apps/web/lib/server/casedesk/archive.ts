/**
 * Session lifecycle: archiving (`POST /api/sessions/:sessionId/archive`). A session id is a write
 * capability, and a published replay exposes the ids of its sessions, so a session is archived before
 * (or when) its run is published. Archiving appends `engine` / `session.archived`; the ledger refuses
 * every later append to the session (409 `session_archived` on every write route) while every read
 * keeps working. The ledger stays append-only: archiving is an entry, not a mutation. Rules confirmed
 * in the session stay in the rulebook (the fold reads every expert session, archived or not).
 *
 * Operator only: `Authorization: Bearer CUSTOM_LLM_SECRET`, like the other operator routes. The
 * session's context version is bumped, so an authorization issued just before cannot be spoken.
 */
import "server-only";
import { randomUUID } from "node:crypto";
import type { z } from "zod";
import { ArchiveSessionRequestSchema, type ArchiveSessionResponseSchema } from "../../contracts/casedesk";
import type { AuthorizationStore } from "../authorizations";
import { rejectUnlessBearer } from "../bearer";
import { json, readJson, respond } from "./http";
import { loadSession, requireNotArchived, type CaseDeskDeps } from "./session";

export type ArchiveDeps = Pick<CaseDeskDeps, "ledger" | "store" | "now"> & {
  secret: string | undefined;
  authorizations: Pick<AuthorizationStore, "bumpContextVersion">;
  log: Pick<Console, "error" | "warn" | "info">;
};

export async function handleArchiveSession(request: Request, sessionId: string, deps: ArchiveDeps): Promise<Response> {
  const denied = rejectUnlessBearer(request.headers, deps.secret, "sessions.archive", deps.log);
  if (denied) return denied;
  return respond(deps.log, async () => {
    const { by, note } = await readJson(request, ArchiveSessionRequestSchema);
    const { session } = loadSession(deps, sessionId);
    requireNotArchived(session);
    const archived = deps.ledger.archive(session.id, { occurredAt: deps.now(), traceId: randomUUID(), by, ...(note !== undefined && { note }) });
    deps.authorizations.bumpContextVersion(session.id);
    deps.log.info(`[casedesk] session ${session.id} archived by ${by}`);
    const body: z.infer<typeof ArchiveSessionResponseSchema> = { sessionId: session.id, archived: true, entryId: archived.id, sequence: archived.sequence };
    return json(body);
  });
}
