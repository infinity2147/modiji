import { caseDeskDeps } from "@/lib/server/casedesk/deps";
import { handleCreateSession } from "@/lib/server/casedesk/sessions";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export function POST(request: Request): Promise<Response> {
  return handleCreateSession(request, caseDeskDeps());
}
