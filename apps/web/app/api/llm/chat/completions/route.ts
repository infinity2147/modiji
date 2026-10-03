/** ElevenLabs appends `/chat/completions` to the agent's `custom_llm.url` (`${PUBLIC_BASE_URL}/api/llm`). */
import { handleChatCompletion } from "@/lib/server/custom-llm";
import { getRuntime } from "@/lib/server/runtime";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function POST(request: Request): Promise<Response> {
  const receivedAt = performance.now();
  const { env, authorizations, ledger } = getRuntime();
  return handleChatCompletion(
    request,
    { secret: env.CUSTOM_LLM_SECRET, authorizations, ledger, now: Date.now, log: console },
    receivedAt,
  );
}
