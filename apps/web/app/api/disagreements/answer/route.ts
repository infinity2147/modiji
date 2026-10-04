import { handleAnswerDisagreement } from "@/lib/server/disagreements/handlers";
import { disagreementDeps } from "@/lib/server/disagreements/runtime-deps";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function POST(request: Request): Promise<Response> {
  return handleAnswerDisagreement(request, disagreementDeps());
}
