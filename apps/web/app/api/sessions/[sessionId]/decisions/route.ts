import { guardSession } from "@/lib/server/auth/access";
import { caseDeskDeps } from "@/lib/server/casedesk/deps";
import { handleCommitDecision } from "@/lib/server/casedesk/interlock";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function POST(request: Request, ctx: RouteContext<"/api/sessions/[sessionId]/decisions">): Promise<Response> {
  const { sessionId } = await ctx.params;
  return guardSession(request, sessionId, "write", () => handleCommitDecision(request, sessionId, caseDeskDeps()));
}
