import { tutorDeps } from "@/lib/server/tutor/deps";
import { handleTutorState } from "@/lib/server/tutor/handlers";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET(_request: Request, ctx: RouteContext<"/api/sessions/[sessionId]/tutor">): Promise<Response> {
  const { sessionId } = await ctx.params;
  return handleTutorState(sessionId, tutorDeps());
}
