import packageJson from "@/package.json";

export const dynamic = "force-dynamic";

type HealthResponse = { ok: true; uptimeS: number; version: string };

export function GET(): Response {
  const body: HealthResponse = {
    ok: true,
    uptimeS: Math.floor(process.uptime()),
    version: packageJson.version,
  };
  return Response.json(body, { headers: { "Cache-Control": "no-store" } });
}
