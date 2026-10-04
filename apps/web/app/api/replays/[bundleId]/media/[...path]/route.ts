import { handleReplayFile } from "@/lib/server/replay/handlers";
import { getReplay } from "@/lib/server/replay/registry";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/** GET /api/replays/:bundleId/media/<sessionId>/frames/<frameId>.png — a redacted frame from the bundle. */
export async function GET(_request: Request, ctx: RouteContext<"/api/replays/[bundleId]/media/[...path]">): Promise<Response> {
  const { bundleId, path } = await ctx.params;
  return handleReplayFile(getReplay(), bundleId, `media/${path.join("/")}`, console);
}
