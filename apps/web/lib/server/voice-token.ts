/**
 * `GET /api/voice/token?agent=interviewer|tutor`: mints a WebRTC conversation token (api-notes §2)
 * so the browser never holds the ElevenLabs key. Public, and every token costs agent minutes, so
 * callers are rate-limited per client IP.
 */
import "server-only";
import { z } from "zod";
import { AGENT_ID_ENV, AGENT_ROLES } from "@vashistha/core";
import type { ServerEnv } from "@vashistha/core/server";
import type { RateLimiter } from "./rate-limit";
import type { Runtime } from "./runtime";

export type VoiceTokenDeps = {
  env: Pick<ServerEnv, (typeof AGENT_ID_ENV)[keyof typeof AGENT_ID_ENV]>;
  elevenLabs: Pick<NonNullable<Runtime["elevenLabs"]>, "getConversationToken"> | null;
  limiter: RateLimiter;
  now: () => number;
  log: Pick<Console, "error">;
};

const NO_STORE = { "Cache-Control": "no-store" };

/**
 * Railway's proxy appends the client address to X-Forwarded-For; its first hop is the client.
 * Without the header (local runs) every caller shares one bucket.
 */
function clientKey(headers: Headers): string {
  return headers.get("x-forwarded-for")?.split(",")[0]?.trim() || "unknown";
}

/**
 * Error class, kind and HTTP status only (read structurally: a value import of the client's error
 * class would pull the server barrel into this bundle). Upstream bodies are never passed on or logged.
 */
function describeUpstreamError(error: unknown): string {
  if (!(error instanceof Error)) return "non-Error thrown";
  const kind = "kind" in error && typeof error.kind === "string" ? ` kind=${error.kind}` : "";
  const status = "status" in error && typeof error.status === "number" ? ` status=${error.status}` : "";
  return `${error.name}${kind}${status}`;
}

export async function handleVoiceToken(request: Request, deps: VoiceTokenDeps): Promise<Response> {
  const query = z
    .object({ agent: z.enum(AGENT_ROLES) })
    .safeParse({ agent: new URL(request.url).searchParams.get("agent") });
  if (!query.success) {
    return Response.json(
      { error: "invalid_agent", detail: 'query parameter "agent" must be "interviewer" or "tutor"' },
      { status: 400, headers: NO_STORE },
    );
  }

  const variable = AGENT_ID_ENV[query.data.agent];
  const agentId = deps.env[variable];
  if (!deps.elevenLabs || agentId === undefined) {
    const missing = [...(deps.elevenLabs ? [] : ["ELEVENLABS_API_KEY"]), ...(agentId === undefined ? [variable] : [])];
    return Response.json(
      { error: "voice_not_configured", detail: `not set on the server: ${missing.join(", ")}`, missing },
      { status: 503, headers: NO_STORE },
    );
  }

  const limited = deps.limiter.take(clientKey(request.headers), deps.now());
  if (!limited.ok) {
    return Response.json(
      { error: "rate_limited", retryAfterS: limited.retryAfterS },
      { status: 429, headers: { ...NO_STORE, "Retry-After": String(limited.retryAfterS) } },
    );
  }

  try {
    const { token, conversationId } = await deps.elevenLabs.getConversationToken(agentId);
    return Response.json({ token, conversationId }, { headers: NO_STORE });
  } catch (error) {
    deps.log.error(`[voice-token] ElevenLabs token request failed: ${describeUpstreamError(error)}`);
    return Response.json({ error: "upstream_error" }, { status: 502, headers: NO_STORE });
  }
}
