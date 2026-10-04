import { guardSession } from "@/lib/server/auth/access";
import { tutorDeps } from "@/lib/server/tutor/deps";
import { handleCoachNudge } from "@/lib/server/tutor/nudges";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/** The trainee's own session only: queues a spoken hint on an open case the trainee has been quiet on. */
export async function POST(request: Request, ctx: RouteContext<"/api/sessions/[sessionId]/tutor/nudge">): Promise<Response> {
  const { sessionId } = await ctx.params;
  return guardSession(request, sessionId, "write", () => handleCoachNudge(request, sessionId, tutorDeps()));
}
