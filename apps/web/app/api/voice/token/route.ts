import { getRuntime } from "@/lib/server/runtime";
import { handleVoiceToken } from "@/lib/server/voice-token";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET(request: Request): Promise<Response> {
  const { env, elevenLabs, voiceTokenLimiter } = getRuntime();
  return handleVoiceToken(request, { env, elevenLabs, limiter: voiceTokenLimiter, now: Date.now, log: console });
}
