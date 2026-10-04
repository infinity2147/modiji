import { accountWithRole, guard, requireAccount } from "@/lib/server/auth/access";
import { adminDeps } from "@/lib/server/auth/deps";
import { handleAccountAction } from "@/lib/server/auth/handlers";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/** Admin only: grant or change a role, decline an expert request, disable or enable an account. */
export async function POST(request: Request, ctx: RouteContext<"/api/admin/users/[userId]">): Promise<Response> {
  const { userId } = await ctx.params;
  return guard(request, accountWithRole("admin"), (principal) => handleAccountAction(request, userId, requireAccount(principal), adminDeps()));
}
