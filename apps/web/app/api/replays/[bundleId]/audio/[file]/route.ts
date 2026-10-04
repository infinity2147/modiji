import { handleReplayFile } from "@/lib/server/replay/handlers";
import { getReplay } from "@/lib/server/replay/registry";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/** GET /api/replays/:bundleId/audio/<conversationId>.mp3 — recorded conversation audio, only if the bundle has it. */
export async function GET(_request: Request, ctx: RouteContext<"/api/replays/[bundleId]/audio/[file]">): Promise<Response> {
  const { bundleId, file } = await ctx.params;
  return handleReplayFile(getReplay(), bundleId, `audio/${file}`, console);
}
