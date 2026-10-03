import { handleLineage } from "@/lib/server/debrief/handlers";
import { debriefDeps } from "@/lib/server/debrief/runtime-deps";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET(request: Request, ctx: RouteContext<"/api/sessions/[sessionId]/lineage">): Promise<Response> {
  const { sessionId } = await ctx.params;
  return handleLineage(request, sessionId, debriefDeps());
}
