import { perceptionDeps } from "@/lib/server/perception/deps";
import { handleGetFrameMedia } from "@/lib/server/perception/media";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET(_request: Request, ctx: RouteContext<"/api/media/[sessionId]/frames/[file]">): Promise<Response> {
  const { sessionId, file } = await ctx.params;
  return handleGetFrameMedia(sessionId, file, perceptionDeps());
}
