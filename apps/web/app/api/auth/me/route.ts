import { guard, anyone, requireAccount } from "@/lib/server/auth/access";
import { viewerOf } from "@/lib/server/auth/handlers";
import { json } from "@/lib/server/casedesk/http";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/** The signed-in account. */
export function GET(request: Request): Promise<Response> {
  return guard(request, anyone, (principal) => json({ viewer: viewerOf(requireAccount(principal)) }));
}
