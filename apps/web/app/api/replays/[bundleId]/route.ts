import { handleOpenReplay } from "@/lib/server/replay/handlers";
import { getReplay } from "@/lib/server/replay/registry";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/** GET /api/replays/:bundleId — re-verifies the bundle from disk, then returns it; 409 with the reason if it does not verify. */
export async function GET(_request: Request, ctx: RouteContext<"/api/replays/[bundleId]">): Promise<Response> {
  const { bundleId } = await ctx.params;
  return handleOpenReplay(getReplay(), bundleId, console);
}
