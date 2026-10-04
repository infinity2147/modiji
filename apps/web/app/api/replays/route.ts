import { handleListReplays } from "@/lib/server/replay/handlers";
import { getReplay } from "@/lib/server/replay/registry";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/** GET /api/replays — verified-replay bundles on this server (manifest facts; opening one re-verifies it). */
export function GET(): Promise<Response> {
  return handleListReplays(getReplay(), console);
}
