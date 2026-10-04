import { guardSession } from "@/lib/server/auth/access";
import { handleExpertAction, handleGetDebrief } from "@/lib/server/debrief/handlers";
import { debriefDeps } from "@/lib/server/debrief/runtime-deps";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET(request: Request, ctx: RouteContext<"/api/sessions/[sessionId]/debrief">): Promise<Response> {
  const { sessionId } = await ctx.params;
  return guardSession(request, sessionId, "read", () => handleGetDebrief(sessionId, debriefDeps()));
}

export async function POST(request: Request, ctx: RouteContext<"/api/sessions/[sessionId]/debrief">): Promise<Response> {
  const { sessionId } = await ctx.params;
  return guardSession(request, sessionId, "write", () => handleExpertAction(request, sessionId, debriefDeps()));
}
