import { handleArchiveSession } from "@/lib/server/casedesk/archive";
import { getRuntime } from "@/lib/server/runtime";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/** Operator only (bearer): closes the session for writing; reads keep working (lib/server/casedesk/archive.ts). */
export async function POST(request: Request, ctx: RouteContext<"/api/sessions/[sessionId]/archive">): Promise<Response> {
  const { sessionId } = await ctx.params;
  const { env, ledger, casedesk, authorizations } = getRuntime();
  return handleArchiveSession(request, sessionId, { ledger, store: casedesk, authorizations, secret: env.CUSTOM_LLM_SECRET, now: Date.now, log: console });
}
