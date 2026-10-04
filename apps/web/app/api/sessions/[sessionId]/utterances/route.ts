import { guardSession } from "@/lib/server/auth/access";
import { handlePostUtterance } from "@/lib/server/interview/handlers";
import { interviewDeps } from "@/lib/server/interview/deps";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function POST(request: Request, ctx: RouteContext<"/api/sessions/[sessionId]/utterances">): Promise<Response> {
  const { sessionId } = await ctx.params;
  return guardSession(request, sessionId, "write", () => handlePostUtterance(request, sessionId, interviewDeps()));
}
