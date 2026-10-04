import { guard } from "@/lib/server/auth/access";
import { getRuntime } from "@/lib/server/runtime";
import { handleVoiceToken } from "@/lib/server/voice-token";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/** The interviewer talks to experts; the tutor to novice sessions (trainees, and admins demoing it). */
export async function GET(request: Request): Promise<Response> {
  const agent = new URL(request.url).searchParams.get("agent");
  return guard(
    request,
    (principal) => {
      if (principal.kind !== "user") return "voice is for signed-in accounts";
      if (agent === "interviewer" && principal.account.role !== "expert") return "the interviewer talks to experts";
      if (agent === "tutor" && principal.account.role === "expert") return "the tutor talks to trainees";
      return undefined;
    },
    () => {
      const { env, elevenLabs, voiceTokenLimiter } = getRuntime();
      return handleVoiceToken(request, { env, elevenLabs, limiter: voiceTokenLimiter, now: Date.now, log: console });
    },
  );
}
