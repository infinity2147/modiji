import { handleListCases } from "@/lib/server/casedesk/sessions";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export function GET(request: Request): Promise<Response> {
  return handleListCases(request, { log: console });
}
