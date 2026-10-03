import { perceptionDeps } from "@/lib/server/perception/deps";
import { handlePostFrame, handleVisionState } from "@/lib/server/perception/frames";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function POST(request: Request, ctx: RouteContext<"/api/sessions/[sessionId]/frames">): Promise<Response> {
  const { sessionId } = await ctx.params;
  return handlePostFrame(request, sessionId, perceptionDeps());
}

export async function GET(_request: Request, ctx: RouteContext<"/api/sessions/[sessionId]/frames">): Promise<Response> {
  const { sessionId } = await ctx.params;
  return handleVisionState(sessionId, perceptionDeps());
}
