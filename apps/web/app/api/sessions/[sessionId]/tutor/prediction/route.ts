import { guardSession } from "@/lib/server/auth/access";
import { tutorDeps } from "@/lib/server/tutor/deps";
import { handlePrediction } from "@/lib/server/tutor/handlers";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function POST(request: Request, ctx: RouteContext<"/api/sessions/[sessionId]/tutor/prediction">): Promise<Response> {
  const { sessionId } = await ctx.params;
  return guardSession(request, sessionId, "write", () => handlePrediction(request, sessionId, tutorDeps()));
}
