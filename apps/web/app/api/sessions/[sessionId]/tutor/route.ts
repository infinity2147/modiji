import { guardSession } from "@/lib/server/auth/access";
import { tutorDeps } from "@/lib/server/tutor/deps";
import { handleTutorState } from "@/lib/server/tutor/handlers";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET(request: Request, ctx: RouteContext<"/api/sessions/[sessionId]/tutor">): Promise<Response> {
  const { sessionId } = await ctx.params;
  return guardSession(request, sessionId, "read", () => handleTutorState(sessionId, tutorDeps()));
}
