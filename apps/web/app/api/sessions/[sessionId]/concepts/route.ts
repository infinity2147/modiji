import { handleConceptAction, handleGetConcepts } from "@/lib/server/schema/handlers";
import { schemaDeps } from "@/lib/server/schema/runtime-deps";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET(_request: Request, ctx: RouteContext<"/api/sessions/[sessionId]/concepts">): Promise<Response> {
  const { sessionId } = await ctx.params;
  return handleGetConcepts(sessionId, schemaDeps());
}

export async function POST(request: Request, ctx: RouteContext<"/api/sessions/[sessionId]/concepts">): Promise<Response> {
  const { sessionId } = await ctx.params;
  return handleConceptAction(request, sessionId, schemaDeps());
}
