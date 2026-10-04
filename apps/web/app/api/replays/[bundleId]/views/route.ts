import { handleReplayViews } from "@/lib/server/replay/handlers";
import { getReplay } from "@/lib/server/replay/registry";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/** GET /api/replays/:bundleId/views?n= — server views derived (read-only) from the first n recorded entries. */
export async function GET(request: Request, ctx: RouteContext<"/api/replays/[bundleId]/views">): Promise<Response> {
  const { bundleId } = await ctx.params;
  return handleReplayViews(request, getReplay(), bundleId, console);
}
