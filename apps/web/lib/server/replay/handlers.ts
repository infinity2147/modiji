/** Route handlers of the verified replay (contract: lib/contracts/replay.ts). Every one is a read. */
import { ReplayViewsQuerySchema } from "../../contracts/replay";
import { ApiFailure, json, parseOr400, respond } from "../casedesk/http";
import { rejectUnlessBearer } from "../bearer";
import type { ImportResult, ReplayService } from "./registry";

type Log = Pick<Console, "info" | "warn" | "error">;

export function handleListReplays(service: ReplayService, log: Log): Promise<Response> {
  return respond(log, async () => json(await service.list()));
}

export function handleOpenReplay(service: ReplayService, bundleId: string, log: Log): Promise<Response> {
  return respond(log, async () => {
    const opened = await service.open(bundleId);
    if (!opened.ok) throw new ApiFailure(opened.status, opened.code, opened.detail);
    return json(opened.body);
  });
}

export function handleReplayViews(request: Request, service: ReplayService, bundleId: string, log: Log): Promise<Response> {
  return respond(log, async () => {
    const { n } = parseOr400(ReplayViewsQuerySchema, Object.fromEntries(new URL(request.url).searchParams), "invalid_query");
    let views = await service.views(bundleId, n);
    if (views === null) {
      // Not verified in this process yet (e.g. after a restart): verify first, never derive from an unverified bundle.
      const opened = await service.open(bundleId);
      if (!opened.ok) throw new ApiFailure(opened.status, opened.code, opened.detail);
      views = await service.views(bundleId, n);
    }
    if (views === null) throw new ApiFailure(404, "not_found", "no such replay bundle");
    return json(views);
  });
}

const CONTENT_TYPES: Record<string, string> = { png: "image/png", mp3: "audio/mpeg" };

export function handleReplayFile(service: ReplayService, bundleId: string, path: string, log: Log): Promise<Response> {
  return respond(log, async () => {
    const bytes = await service.file(bundleId, path);
    if (bytes === null) throw new ApiFailure(404, "not_found", "no such file in a verified replay bundle");
    return new Response(bytes, {
      status: 200,
      headers: {
        "Content-Type": CONTENT_TYPES[path.split(".").at(-1) ?? ""] ?? "application/octet-stream",
        "Content-Length": String(bytes.byteLength),
        "Cache-Control": "private, max-age=3600, immutable",
        "X-Content-Type-Options": "nosniff",
        "Content-Security-Policy": "default-src 'none'",
      },
    });
  });
}

function importResponse(result: ImportResult): Response {
  if (!result.ok) throw new ApiFailure(result.status, result.code, result.detail);
  return json({ ok: true, detail: result.detail });
}

/** PUT /api/replays/:bundleId/import/<path> — bearer (CUSTOM_LLM_SECRET); stages one file of an exported bundle. */
export function handleImportFile(request: Request, service: ReplayService, secret: string | undefined, bundleId: string, path: string, log: Log): Promise<Response> {
  return respond(log, async () => {
    const denied = rejectUnlessBearer(request.headers, secret, "replay.import", log);
    if (denied !== null) return denied;
    return importResponse(await service.stage(bundleId, path, new Uint8Array(await request.arrayBuffer())));
  });
}

/** POST /api/replays/:bundleId/import — bearer; verifies the staged bundle (hashes + chain) and moves it into place. */
export function handleImportCommit(request: Request, service: ReplayService, secret: string | undefined, bundleId: string, log: Log): Promise<Response> {
  return respond(log, async () => {
    const denied = rejectUnlessBearer(request.headers, secret, "replay.import", log);
    if (denied !== null) return denied;
    return importResponse(await service.commit(bundleId));
  });
}
