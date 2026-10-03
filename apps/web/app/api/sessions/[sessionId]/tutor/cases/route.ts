import { tutorDeps } from "@/lib/server/tutor/deps";
import { handleJudgeCase } from "@/lib/server/tutor/handlers";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function POST(request: Request, ctx: RouteContext<"/api/sessions/[sessionId]/tutor/cases">): Promise<Response> {
  const { sessionId } = await ctx.params;
  return handleJudgeCase(request, sessionId, tutorDeps());
}
