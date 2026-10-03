import { tutorDeps } from "@/lib/server/tutor/deps";
import { handleIntent } from "@/lib/server/tutor/handlers";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function POST(request: Request, ctx: RouteContext<"/api/sessions/[sessionId]/tutor/intent">): Promise<Response> {
  const { sessionId } = await ctx.params;
  return handleIntent(request, sessionId, tutorDeps());
}
