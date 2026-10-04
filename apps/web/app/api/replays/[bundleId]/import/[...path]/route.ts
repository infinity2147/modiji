import { handleImportFile } from "@/lib/server/replay/handlers";
import { getReplay } from "@/lib/server/replay/registry";
import { getRuntime } from "@/lib/server/runtime";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/** PUT /api/replays/:bundleId/import/<path> — guarded (bearer): stage one file of an exported bundle. */
export async function PUT(request: Request, ctx: RouteContext<"/api/replays/[bundleId]/import/[...path]">): Promise<Response> {
  const { bundleId, path } = await ctx.params;
  return handleImportFile(request, getReplay(), getRuntime().env.CUSTOM_LLM_SECRET, bundleId, path.join("/"), console);
}
