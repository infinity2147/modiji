import { handleExpertAction, handleGetDebrief } from "@/lib/server/debrief/handlers";
import { debriefDeps } from "@/lib/server/debrief/runtime-deps";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET(_request: Request, ctx: RouteContext<"/api/sessions/[sessionId]/debrief">): Promise<Response> {
  const { sessionId } = await ctx.params;
  return handleGetDebrief(sessionId, debriefDeps());
}

export async function POST(request: Request, ctx: RouteContext<"/api/sessions/[sessionId]/debrief">): Promise<Response> {
  const { sessionId } = await ctx.params;
  return handleExpertAction(request, sessionId, debriefDeps());
}
