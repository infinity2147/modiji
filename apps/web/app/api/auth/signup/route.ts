import { authDeps } from "@/lib/server/auth/deps";
import { handleSignUp } from "@/lib/server/auth/handlers";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/** Public: creates a trainee account and signs it in. */
export function POST(request: Request): Promise<Response> {
  return handleSignUp(request, authDeps());
}
