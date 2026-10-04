import { guard, guardDisagreementSearch } from "@/lib/server/auth/access";
import { handleGetDisagreements, handleSearchDisagreements } from "@/lib/server/disagreements/handlers";
import { disagreementDeps } from "@/lib/server/disagreements/runtime-deps";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/** Experts, admins and the operator read the directory and a pair's reconciliation. */
export async function GET(request: Request): Promise<Response> {
  return guard(
    request,
    (principal) => (principal.kind === "operator" || principal.account.role !== "trainee" ? undefined : "two-expert reconciliation is for experts and admins"),
    () => handleGetDisagreements(request, disagreementDeps()),
  );
}

export async function POST(request: Request): Promise<Response> {
  return guardDisagreementSearch(request, () => handleSearchDisagreements(request, disagreementDeps()));
}
