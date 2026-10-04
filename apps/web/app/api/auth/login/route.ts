import { authDeps } from "@/lib/server/auth/deps";
import { handleSignIn } from "@/lib/server/auth/handlers";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/** Public. */
export function POST(request: Request): Promise<Response> {
  return handleSignIn(request, authDeps());
}
