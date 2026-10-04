import { guardSession } from "@/lib/server/auth/access";
import { caseDeskDeps } from "@/lib/server/casedesk/deps";
import { handlePostEvents } from "@/lib/server/casedesk/events";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function POST(request: Request, ctx: RouteContext<"/api/sessions/[sessionId]/events">): Promise<Response> {
  const { sessionId } = await ctx.params;
  return guardSession(request, sessionId, "write", () => handlePostEvents(request, sessionId, caseDeskDeps()));
}
