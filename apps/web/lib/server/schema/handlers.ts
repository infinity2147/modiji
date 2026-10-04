/**
 * HTTP handlers of `/api/sessions/:sessionId/concepts` (contract: lib/contracts/concepts.ts). Route files
 * only adapt Next's signature and pass `schemaDeps()`.
 */
import "server-only";
import { ConceptActionRequestSchema, type ConceptActionResponseSchema } from "../../contracts/concepts";
import { json, readJson, respond } from "../casedesk/http";
import type { z } from "zod";
import type { SchemaDeps } from "./deps";
import { applyConceptAction, conceptsState } from "./service";

/** GET — undefined concepts, confirmed concepts with their backfill, the schema version. */
export function handleGetConcepts(sessionId: string, deps: SchemaDeps): Promise<Response> {
  return respond(deps.log, () => json(conceptsState(deps, sessionId)));
}

/** POST — the expert confirms (with their definition and words) or dismisses an undefined concept. */
export function handleConceptAction(request: Request, sessionId: string, deps: SchemaDeps): Promise<Response> {
  return respond(deps.log, async () => {
    const body = await readJson(request, ConceptActionRequestSchema);
    const response: z.infer<typeof ConceptActionResponseSchema> = applyConceptAction(deps, sessionId, body);
    return json(response);
  });
}
