import { rejectUnlessBearer } from "@/lib/server/bearer";
import { usageBreakdown, volumeRoot, volumeStats } from "@/lib/server/disk";
import { getRuntime } from "@/lib/server/runtime";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/**
 * Operator-only, read-only: what is using the persistent volume, largest first. Bounded by file count and time so it
 * cannot stall the server. Paths are relative to the volume root; file contents are never read.
 */
export async function GET(request: Request): Promise<Response> {
  const { env } = getRuntime();
  const denied = rejectUnlessBearer(request.headers, env.CUSTOM_LLM_SECRET, "health.disk", console);
  if (denied) return denied;
  const root = volumeRoot(env.DATA_DIR, process.env.RAILWAY_VOLUME_MOUNT_PATH);
  const report = await usageBreakdown(root);
  return Response.json(
    { dataDir: env.DATA_DIR, volume: volumeStats(root), ...report },
    { headers: { "Cache-Control": "no-store" } },
  );
}
