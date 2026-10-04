/** `Authorization: Bearer <CUSTOM_LLM_SECRET>` for the server-to-server endpoints. */
import { createHash, timingSafeEqual } from "node:crypto";

export type AuthLog = Pick<Console, "warn">;

/**
 * Scheme names safe to log. Anything else is logged as "other": a client that sends the raw secret
 * without a scheme would otherwise have its secret logged as the "scheme".
 */
const KNOWN_SCHEMES = new Set(["bearer", "basic", "token", "apikey", "api-key", "key", "digest"]);

/** Hashing first makes the comparison constant-time regardless of the presented length. */
function secretsEqual(presented: string, secret: string): boolean {
  const digest = (value: string) => createHash("sha256").update(value).digest();
  return timingSafeEqual(digest(presented), digest(secret));
}

/** Names only, never values: lets preflight see which header ElevenLabs actually sent (UNVERIFIED). */
function describeAuth(headers: Headers): { scheme: string; authLikeHeaders: string[] } {
  const raw = headers.get("authorization");
  const first = raw?.trim().split(/\s+/, 1)[0]?.toLowerCase();
  const scheme = raw === null ? "absent" : first !== undefined && KNOWN_SCHEMES.has(first) ? first : "other";
  const authLikeHeaders = [...headers.keys()].filter((name) => /auth|key|token|secret/i.test(name));
  return { scheme, authLikeHeaders };
}

/** True when `authorization` is `Bearer <secret>` (false while no secret is configured). */
export function bearerMatches(authorization: string | null | undefined, secret: string | undefined): boolean {
  if (secret === undefined) return false;
  const match = /^Bearer\s+(\S+)\s*$/i.exec(authorization ?? "");
  return match?.[1] !== undefined && secretsEqual(match[1], secret);
}

/**
 * Returns null when the request carries the secret, otherwise the response to send:
 * 401 for a missing or wrong credential, 503 when no secret is configured (development only;
 * production refuses to boot without one).
 */
export function rejectUnlessBearer(
  headers: Headers,
  secret: string | undefined,
  endpoint: string,
  log: AuthLog,
): Response | null {
  if (secret === undefined) {
    log.warn(`[auth] ${endpoint}: CUSTOM_LLM_SECRET is not set; refusing`);
    return Response.json({ error: "not_configured", detail: "CUSTOM_LLM_SECRET is not set" }, { status: 503 });
  }
  const match = /^Bearer\s+(\S+)\s*$/i.exec(headers.get("authorization") ?? "");
  if (match?.[1] !== undefined && secretsEqual(match[1], secret)) return null;
  const { scheme, authLikeHeaders } = describeAuth(headers);
  log.warn(`[auth] ${endpoint}: 401 (scheme=${scheme}; auth-like headers=[${authLikeHeaders.join(", ")}])`);
  return Response.json(
    { error: "unauthorized" },
    { status: 401, headers: { "WWW-Authenticate": 'Bearer realm="vashistha"' } },
  );
}
