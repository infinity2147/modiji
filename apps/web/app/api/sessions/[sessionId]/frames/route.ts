import { guardSession } from "@/lib/server/auth/access";
import { perceptionDeps } from "@/lib/server/perception/deps";
import { handlePostFrame, handleVisionState } from "@/lib/server/perception/frames";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function POST(request: Request, ctx: RouteContext<"/api/sessions/[sessionId]/frames">): Promise<Response> {
  const { sessionId } = await ctx.params;
  return guardSession(request, sessionId, "write", () => handlePostFrame(request, sessionId, perceptionDeps()));
}

export async function GET(request: Request, ctx: RouteContext<"/api/sessions/[sessionId]/frames">): Promise<Response> {
  const { sessionId } = await ctx.params;
  return guardSession(request, sessionId, "read", () => handleVisionState(sessionId, perceptionDeps()));
}
