import { rejectUnlessBearer } from "@/lib/server/bearer";
import { getRuntime } from "@/lib/server/runtime";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/** Preflight's "DB and DATA_DIR writable · Z3 initialises" (plan §12). 503 unless every check passes. */
export async function GET(request: Request): Promise<Response> {
  const { env, checks } = getRuntime();
  const denied = rejectUnlessBearer(request.headers, env.CUSTOM_LLM_SECRET, "health.deep", console);
  if (denied) return denied;
  const db = checks.db();
  const [dataDir, z3] = await Promise.all([checks.dataDir(), checks.z3()]);
  const ok = db.ok && dataDir.ok && z3.ok;
  return Response.json({ ok, db, dataDir, z3 }, { status: ok ? 200 : 503, headers: { "Cache-Control": "no-store" } });
}
