import { handleGetDisagreements, handleSearchDisagreements } from "@/lib/server/disagreements/handlers";
import { disagreementDeps } from "@/lib/server/disagreements/runtime-deps";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET(request: Request): Promise<Response> {
  return handleGetDisagreements(request, disagreementDeps());
}

export async function POST(request: Request): Promise<Response> {
  return handleSearchDisagreements(request, disagreementDeps());
}
