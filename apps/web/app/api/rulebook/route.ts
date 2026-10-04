import { anyone, guard } from "@/lib/server/auth/access";
import { handleGetRulebook } from "@/lib/server/debrief/handlers";
import { getRuntime } from "@/lib/server/runtime";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/** The team rulebook in force: what the interlock, tutor and MCP evaluate (open disagreements' decision rules held back). */
export async function GET(request: Request): Promise<Response> {
  return guard(request, anyone, () => handleGetRulebook({ rulebook: getRuntime().rulebookState, log: console }));
}
