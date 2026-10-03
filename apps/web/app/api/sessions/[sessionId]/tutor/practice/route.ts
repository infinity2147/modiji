import { tutorDeps } from "@/lib/server/tutor/deps";
import { handlePractice } from "@/lib/server/tutor/handlers";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function POST(_request: Request, ctx: RouteContext<"/api/sessions/[sessionId]/tutor/practice">): Promise<Response> {
  const { sessionId } = await ctx.params;
  return handlePractice(sessionId, tutorDeps());
}
