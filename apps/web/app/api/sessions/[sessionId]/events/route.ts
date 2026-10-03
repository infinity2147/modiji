import { caseDeskDeps } from "@/lib/server/casedesk/deps";
import { handlePostEvents } from "@/lib/server/casedesk/events";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function POST(request: Request, ctx: RouteContext<"/api/sessions/[sessionId]/events">): Promise<Response> {
  const { sessionId } = await ctx.params;
  return handlePostEvents(request, sessionId, caseDeskDeps());
}
