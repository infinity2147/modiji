import { authDeps } from "@/lib/server/auth/deps";
import { handleSignOut } from "@/lib/server/auth/handlers";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/** Public: ends this browser's sign-in, if any. */
export function POST(request: Request): Promise<Response> {
  return handleSignOut(request, authDeps());
}
