/**
 * `GET /api/media/:sessionId/frames/:file` — a stored redacted frame, session-scoped. The file name
 * must be `<frameId>.png` with a UUID frame id, the session must be a CaseDesk session, and the frame
 * must be recorded in THAT session's ledger (`frame.received`); only then is the file read, from a
 * path built from the two validated UUIDs (see storage.ts). Everything else is 404, so the route
 * never reveals whether a file exists elsewhere.
 */
import { z } from "zod";
import { ApiFailure, respond } from "../casedesk/http";
import { loadSession } from "../casedesk/session";
import type { PerceptionDeps } from "./frames";
import { isUuid, readFrame } from "./storage";

const FrameIdPayloadSchema = z.object({ frameId: z.string() });

function notFound(): ApiFailure {
  return new ApiFailure(404, "not_found", "no such frame in this session");
}

export function handleGetFrameMedia(sessionId: string, file: string, deps: Omit<PerceptionDeps, "perception" | "now">): Promise<Response> {
  return respond(deps.log, async () => {
    const match = /^([0-9a-f-]{36})\.png$/.exec(file);
    const frameId = match?.[1];
    if (frameId === undefined || !isUuid(frameId) || !isUuid(sessionId)) throw notFound();
    const { session } = loadSession(deps, sessionId);
    const recorded = deps.ledger
      .list(session.id, { sources: ["client"], kinds: ["frame.received"] })
      .some((entry) => FrameIdPayloadSchema.safeParse(entry.payload).data?.frameId === frameId);
    if (!recorded) throw notFound();
    const png = await readFrame(deps.dataDir, session.id, frameId);
    if (png === null) throw notFound();
    return new Response(new Uint8Array(png), {
      status: 200,
      headers: {
        "Content-Type": "image/png",
        "Content-Length": String(png.length),
        // Frames are immutable once written; private because the session id is the capability.
        "Cache-Control": "private, max-age=3600, immutable",
        "X-Content-Type-Options": "nosniff",
        "Content-Security-Policy": "default-src 'none'",
      },
    });
  });
}
