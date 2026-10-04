/**
 * HTTP handlers of the debrief, Work Map, lineage and rulebook routes (contract:
 * lib/contracts/debrief.ts). Route files only adapt Next's signature and pass `debriefDeps()`.
 */
import "server-only";
import { z } from "zod";
import { IdSchema } from "@vashistha/core";
import {
  DebriefConversationRequestSchema,
  ExpertActionRequestSchema,
  type DebriefState,
  type ExpertActionResponseSchema,
  type RulebookResponseSchema,
} from "../../contracts/debrief";
import { ApiFailure, NO_STORE, json, parseOr400, readJson, respond } from "../casedesk/http";
import { applyExpertAction, generateTeachBack, rebuildWitnesses } from "./actions";
import { conversationView, replyToConversation, startConversation, type ConversationDeps } from "./conversation";
import type { DebriefDeps } from "./deps";
import { lineageView } from "./lineage";
import { debriefState, snapshot } from "./state";
import { sessionWorkMap } from "./workmap";

async function stateOf(deps: DebriefDeps, sessionId: string): Promise<DebriefState> {
  return debriefState(deps, await snapshot(deps, sessionId));
}

/** GET /api/sessions/:sessionId/debrief */
export function handleGetDebrief(sessionId: string, deps: DebriefDeps): Promise<Response> {
  return respond(deps.log, async () => json(await stateOf(deps, sessionId)));
}

/** POST /api/sessions/:sessionId/debrief — an explicit expert action with the expert's typed words. */
export function handleExpertAction(request: Request, sessionId: string, deps: DebriefDeps): Promise<Response> {
  return respond(deps.log, async () => {
    const body = await readJson(request, ExpertActionRequestSchema);
    const result = await applyExpertAction(deps, sessionId, body);
    const response: z.infer<typeof ExpertActionResponseSchema> = { ...result, state: await stateOf(deps, sessionId) };
    return json(response);
  });
}

/** POST /api/sessions/:sessionId/witnesses — rerun the solver, record witnesses, queue debrief questions. */
export function handleRebuildWitnesses(sessionId: string, deps: DebriefDeps): Promise<Response> {
  return respond(deps.log, async () => {
    await rebuildWitnesses(deps, sessionId);
    return json(await stateOf(deps, sessionId));
  });
}

/** POST /api/sessions/:sessionId/teachback — write and queue a teach-back of the rulebook in force. */
export function handleGenerateTeachBack(sessionId: string, deps: DebriefDeps): Promise<Response> {
  return respond(deps.log, async () => {
    await generateTeachBack(deps, sessionId);
    return json(await stateOf(deps, sessionId));
  });
}

/** GET /api/sessions/:sessionId/workmap */
export function handleGetWorkMap(sessionId: string, deps: DebriefDeps): Promise<Response> {
  return respond(deps.log, async () => json(await sessionWorkMap(deps, sessionId)));
}

const ExportFormatSchema = z.enum(["json", "procedure"]);

/** GET /api/sessions/:sessionId/workmap/export?format=json|procedure — a download of the deterministic export. */
export function handleExport(request: Request, sessionId: string, deps: DebriefDeps): Promise<Response> {
  return respond(deps.log, async () => {
    const format = parseOr400(ExportFormatSchema, new URL(request.url).searchParams.get("format") ?? "json", "invalid_format");
    const { workMap } = await sessionWorkMap(deps, sessionId);
    const body =
      format === "json"
        ? deps.exports.workMapJson(workMap)
        : // The session's feature model: its rules may read concepts the expert confirmed (plan §6.6).
          deps.exports.procedure({ domain: (await snapshot(deps, sessionId)).domain, rules: workMap.rules, revision: workMap.rulebookRevision });
    const name = format === "json" ? `workmap-${workMap.id}.json` : `procedure-r${workMap.rulebookRevision}.md`;
    return new Response(body, {
      status: 200,
      headers: {
        ...NO_STORE,
        "Content-Type": format === "json" ? "application/json; charset=utf-8" : "text/markdown; charset=utf-8",
        "Content-Disposition": `attachment; filename="${name}"`,
      },
    });
  });
}

/** GET /api/sessions/:sessionId/lineage?entryId=… */
export function handleLineage(request: Request, sessionId: string, deps: DebriefDeps): Promise<Response> {
  return respond(deps.log, async () => {
    const entryId = new URL(request.url).searchParams.get("entryId");
    if (entryId === null) throw new ApiFailure(400, "invalid_request", "entryId is required");
    return json(await lineageView(deps, sessionId, parseOr400(IdSchema, entryId, "invalid_request")));
  });
}

/** GET /api/rulebook — the confirmed rulebook in force: the team rulebook (every expert session; decision rules of open disagreements held back). */
export function handleGetRulebook(deps: Pick<DebriefDeps, "rulebook" | "log">): Promise<Response> {
  return respond(deps.log, () => {
    const { rules, revision } = deps.rulebook();
    const body: z.infer<typeof RulebookResponseSchema> = { revision, rules };
    return json(body);
  });
}

/** GET /api/sessions/:sessionId/debrief/conversation — the conversation so far (read-only). */
export function handleGetConversation(sessionId: string, deps: ConversationDeps): Promise<Response> {
  return respond(deps.debrief.log, async () => json(await conversationView(deps, sessionId)));
}

/** POST /api/sessions/:sessionId/debrief/conversation — start (or resume) the debrief conversation, or reply to it in the expert's own words. */
export function handleConversation(request: Request, sessionId: string, deps: ConversationDeps): Promise<Response> {
  return respond(deps.debrief.log, async () => {
    const body = await readJson(request, DebriefConversationRequestSchema);
    if (body.type === "start") await startConversation(deps, sessionId);
    else await replyToConversation(deps, sessionId, { text: body.text, via: "chat" });
    return json(await conversationView(deps, sessionId));
  });
}
