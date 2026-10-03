import { tutorDeps } from "@/lib/server/tutor/deps";
import { handlePrediction } from "@/lib/server/tutor/handlers";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function POST(request: Request, ctx: RouteContext<"/api/sessions/[sessionId]/tutor/prediction">): Promise<Response> {
  const { sessionId } = await ctx.params;
  return handlePrediction(request, sessionId, tutorDeps());
}
