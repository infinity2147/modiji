import { handleEngineState } from "@/lib/server/interview/handlers";
import { interviewDeps } from "@/lib/server/interview/deps";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET(_request: Request, ctx: RouteContext<"/api/sessions/[sessionId]/engine">): Promise<Response> {
  const { sessionId } = await ctx.params;
  return handleEngineState(sessionId, interviewDeps());
}
