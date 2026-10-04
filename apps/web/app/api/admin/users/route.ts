import { accountWithRole, guard } from "@/lib/server/auth/access";
import { adminDeps } from "@/lib/server/auth/deps";
import { handleListAccounts } from "@/lib/server/auth/handlers";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/** Admin only: every account, and the account audit trail. */
export function GET(request: Request): Promise<Response> {
  return guard(request, accountWithRole("admin"), () => handleListAccounts(adminDeps()));
}
