import { handleGateAuthorize } from "@/lib/server/interview/handlers";
import { interviewDeps } from "@/lib/server/interview/deps";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function POST(request: Request, ctx: RouteContext<"/api/sessions/[sessionId]/gate/authorize">): Promise<Response> {
  const { sessionId } = await ctx.params;
  return handleGateAuthorize(request, sessionId, interviewDeps());
}
