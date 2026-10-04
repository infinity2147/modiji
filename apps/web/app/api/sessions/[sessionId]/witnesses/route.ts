import { guardSession } from "@/lib/server/auth/access";
import { handleRebuildWitnesses } from "@/lib/server/debrief/handlers";
import { debriefDeps } from "@/lib/server/debrief/runtime-deps";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function POST(request: Request, ctx: RouteContext<"/api/sessions/[sessionId]/witnesses">): Promise<Response> {
  const { sessionId } = await ctx.params;
  return guardSession(request, sessionId, "write", () => handleRebuildWitnesses(sessionId, debriefDeps()));
}
