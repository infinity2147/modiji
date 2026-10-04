import { handleImportCommit } from "@/lib/server/replay/handlers";
import { getReplay } from "@/lib/server/replay/registry";
import { getRuntime } from "@/lib/server/runtime";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/** POST /api/replays/:bundleId/import — guarded (bearer): verify the staged bundle and move it into DATA_DIR/replays. */
export async function POST(request: Request, ctx: RouteContext<"/api/replays/[bundleId]/import">): Promise<Response> {
  const { bundleId } = await ctx.params;
  return handleImportCommit(request, getReplay(), getRuntime().env.CUSTOM_LLM_SECRET, bundleId, console);
}
