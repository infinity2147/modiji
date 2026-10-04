import { guard, requireAccount } from "@/lib/server/auth/access";
import { caseDeskDeps } from "@/lib/server/casedesk/deps";
import { handleCreateSession } from "@/lib/server/casedesk/sessions";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/** A signed-in account starts a session it owns; its role decides the mode and case set (lib/auth/policy.ts). */
export function POST(request: Request): Promise<Response> {
  return guard(
    request,
    (principal) => (principal.kind === "user" ? undefined : "sessions are started by a signed-in account"),
    (principal) => handleCreateSession(request, caseDeskDeps(), requireAccount(principal)),
  );
}
