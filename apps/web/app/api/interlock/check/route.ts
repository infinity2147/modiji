import { caseDeskDeps } from "@/lib/server/casedesk/deps";
import { handleInterlockCheck } from "@/lib/server/casedesk/interlock";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export function POST(request: Request): Promise<Response> {
  return handleInterlockCheck(request, caseDeskDeps());
}
