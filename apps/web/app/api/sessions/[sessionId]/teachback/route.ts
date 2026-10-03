import { handleGenerateTeachBack } from "@/lib/server/debrief/handlers";
import { debriefDeps } from "@/lib/server/debrief/runtime-deps";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function POST(_request: Request, ctx: RouteContext<"/api/sessions/[sessionId]/teachback">): Promise<Response> {
  const { sessionId } = await ctx.params;
  return handleGenerateTeachBack(sessionId, debriefDeps());
}
