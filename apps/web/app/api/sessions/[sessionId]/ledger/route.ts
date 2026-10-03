import { caseDeskDeps } from "@/lib/server/casedesk/deps";
import { handleLedgerPage } from "@/lib/server/casedesk/ledger-page";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET(request: Request, ctx: RouteContext<"/api/sessions/[sessionId]/ledger">): Promise<Response> {
  const { sessionId } = await ctx.params;
  return handleLedgerPage(request, sessionId, caseDeskDeps());
}
