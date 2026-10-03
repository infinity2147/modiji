import { handlePostUtterance } from "@/lib/server/interview/handlers";
import { interviewDeps } from "@/lib/server/interview/deps";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function POST(request: Request, ctx: RouteContext<"/api/sessions/[sessionId]/utterances">): Promise<Response> {
  const { sessionId } = await ctx.params;
  return handlePostUtterance(request, sessionId, interviewDeps());
}
