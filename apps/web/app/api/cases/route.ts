import { listableCaseSets } from "@/lib/auth/policy";
import { guard, guardSession } from "@/lib/server/auth/access";
import { caseDeskDeps } from "@/lib/server/casedesk/deps";
import { handleListCases } from "@/lib/server/casedesk/sessions";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/** With `session=`: that session's cases (its readers only). Without: a set the account's role may work. */
export function GET(request: Request): Promise<Response> {
  const params = new URL(request.url).searchParams;
  const sessionId = params.get("session");
  if (sessionId !== null) return guardSession(request, sessionId, "read", () => handleListCases(request, caseDeskDeps()));
  const set = params.get("set");
  return guard(
    request,
    (principal) =>
      principal.kind === "operator" || listableCaseSets(principal.account.role).some((s) => s === set)
        ? undefined
        : `the ${principal.account.role} role does not work the ${set ?? "(missing)"} set`,
    () => handleListCases(request, caseDeskDeps()),
  );
}
