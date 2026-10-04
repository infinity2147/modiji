import { guardSession } from "@/lib/server/auth/access";
import { tutorDeps } from "@/lib/server/tutor/deps";
import { handleBriefing } from "@/lib/server/tutor/handlers";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/** The trainee's own session only: queues the coach's spoken welcome. */
export async function POST(request: Request, ctx: RouteContext<"/api/sessions/[sessionId]/tutor/briefing">): Promise<Response> {
  const { sessionId } = await ctx.params;
  return guardSession(request, sessionId, "write", () => handleBriefing(request, sessionId, tutorDeps()));
}
