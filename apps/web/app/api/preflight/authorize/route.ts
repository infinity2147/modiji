import { rejectUnlessBearer } from "@/lib/server/bearer";
import { issuePreflightAuthorization } from "@/lib/server/preflight";
import { getRuntime } from "@/lib/server/runtime";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/** Takes no body: the only question it can authorise is the fixed preflight question. */
export function POST(request: Request): Response {
  const { env, ledger, authorizations } = getRuntime();
  const denied = rejectUnlessBearer(request.headers, env.CUSTOM_LLM_SECRET, "preflight.authorize", console);
  if (denied) return denied;
  const body = issuePreflightAuthorization({ ledger, authorizations, now: Date.now });
  return Response.json(body, { headers: { "Cache-Control": "no-store" } });
}
