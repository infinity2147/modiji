import packageJson from "@/package.json";

export const dynamic = "force-dynamic";

/** `commit`: the deployed git commit when the platform provides it (Railway GitHub deploys), else null. Replay bundles record it. */
type HealthResponse = { ok: true; uptimeS: number; version: string; commit: string | null };

export function GET(): Response {
  const body: HealthResponse = {
    ok: true,
    uptimeS: Math.floor(process.uptime()),
    version: packageJson.version,
    commit: process.env.RAILWAY_GIT_COMMIT_SHA ?? process.env.GIT_COMMIT ?? null,
  };
  return Response.json(body, { headers: { "Cache-Control": "no-store" } });
}
