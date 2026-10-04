import { guardSession } from "@/lib/server/auth/access";
import { handleConversation, handleGetConversation } from "@/lib/server/debrief/handlers";
import { debriefDeps } from "@/lib/server/debrief/runtime-deps";
import { schemaDeps } from "@/lib/server/schema/runtime-deps";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET(request: Request, ctx: RouteContext<"/api/sessions/[sessionId]/debrief/conversation">): Promise<Response> {
  const { sessionId } = await ctx.params;
  return guardSession(request, sessionId, "read", () => handleGetConversation(sessionId, { debrief: debriefDeps(), schema: schemaDeps() }));
}

export async function POST(request: Request, ctx: RouteContext<"/api/sessions/[sessionId]/debrief/conversation">): Promise<Response> {
  const { sessionId } = await ctx.params;
  return guardSession(request, sessionId, "write", () => handleConversation(request, sessionId, { debrief: debriefDeps(), schema: schemaDeps() }));
}
