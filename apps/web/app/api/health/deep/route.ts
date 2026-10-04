import { rejectUnlessBearer } from "@/lib/server/bearer";
import { deepHealth } from "@/lib/server/health";
import { getRuntime } from "@/lib/server/runtime";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/** Preflight's "DB and DATA_DIR writable · Z3 initialises" (plan §12) and `llmCalls`. 503 unless every probe passes. */
export async function GET(request: Request): Promise<Response> {
  const runtime = getRuntime();
  const denied = rejectUnlessBearer(request.headers, runtime.env.CUSTOM_LLM_SECRET, "health.deep", console);
  if (denied) return denied;
  const body = await deepHealth(runtime);
  return Response.json(body, { status: body.ok ? 200 : 503, headers: { "Cache-Control": "no-store" } });
}
