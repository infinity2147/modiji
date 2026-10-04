import { guardSessionInBody } from "@/lib/server/auth/access";
import { caseDeskDeps } from "@/lib/server/casedesk/deps";
import { handleInterlockCheck } from "@/lib/server/casedesk/interlock";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/** Records the check in the session named in the body: its owner only. */
export function POST(request: Request): Promise<Response> {
  return guardSessionInBody(request, "write", () => handleInterlockCheck(request, caseDeskDeps()));
}
