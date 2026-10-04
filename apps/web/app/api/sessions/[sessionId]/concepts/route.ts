import { guardSession } from "@/lib/server/auth/access";
import { handleConceptAction, handleGetConcepts } from "@/lib/server/schema/handlers";
import { schemaDeps } from "@/lib/server/schema/runtime-deps";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET(request: Request, ctx: RouteContext<"/api/sessions/[sessionId]/concepts">): Promise<Response> {
  const { sessionId } = await ctx.params;
  return guardSession(request, sessionId, "read", () => handleGetConcepts(sessionId, schemaDeps()));
}

export async function POST(request: Request, ctx: RouteContext<"/api/sessions/[sessionId]/concepts">): Promise<Response> {
  const { sessionId } = await ctx.params;
  return guardSession(request, sessionId, "write", () => handleConceptAction(request, sessionId, schemaDeps()));
}
