/**
 * Small HTTP helpers for calling the deployment under test, plus the preflight authorization client
 * (`POST /api/preflight/authorize`). Response bodies are never echoed whole: callers report shapes and statuses.
 */
import type { PreflightContext } from "./types";

export type HttpResult = { status: number; contentType: string; text: string; ms: number };

export class CheckFailure extends Error {
  override readonly name: string = "CheckFailure";
}

export function describeError(error: unknown): string {
  if (!(error instanceof Error)) return String(error);
  if (error.name === "TimeoutError") return "timed out";
  const cause = error.cause instanceof Error ? ` (${error.cause.message})` : "";
  return `${error.message}${cause}`;
}

export function joinUrl(baseUrl: string, path: string): string {
  return `${baseUrl}${path}`;
}

/** One request with a whole-response timeout (headers and body). Network errors become `CheckFailure`. */
export async function httpRequest(
  ctx: Pick<PreflightContext, "fetch" | "now" | "options">,
  url: string,
  init: RequestInit = {},
): Promise<HttpResult> {
  const started = ctx.now();
  const signal = AbortSignal.timeout(ctx.options.httpTimeoutMs);
  try {
    const response = await ctx.fetch(url, { ...init, signal, redirect: "manual" });
    const text = await response.text();
    return {
      status: response.status,
      contentType: response.headers.get("content-type") ?? "",
      text,
      ms: Math.round(ctx.now() - started),
    };
  } catch (error) {
    const path = new URL(url).pathname;
    throw new CheckFailure(`${init.method ?? "GET"} ${path}: ${describeError(error)}`);
  }
}

export function parseJsonObject(text: string): Record<string, unknown> | null {
  try {
    const value: unknown = JSON.parse(text);
    return value !== null && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

export function bearer(secret: string): Record<string, string> {
  return { authorization: `Bearer ${secret}` };
}

export type PreflightAuthorization = {
  sessionId: string;
  nonce: string;
  controlMessage: string;
  text: string;
  expiresAt: number;
};

/**
 * `POST /api/preflight/authorize`: a fresh ledger session plus a single-use authorization (≤60 s) for the fixed
 * preflight question. The nonce and control message are registered as secrets before this returns.
 */
export async function authorizePreflight(
  ctx: Pick<PreflightContext, "fetch" | "now" | "options" | "secrets">,
  baseUrl: string,
  secret: string,
): Promise<PreflightAuthorization> {
  const r = await httpRequest(ctx, joinUrl(baseUrl, "/api/preflight/authorize"), { method: "POST", headers: bearer(secret) });
  if (r.status !== 200) throw new CheckFailure(`POST /api/preflight/authorize returned HTTP ${r.status}`);
  const body = parseJsonObject(r.text);
  const { sessionId, nonce, controlMessage, text, expiresAt } = body ?? {};
  if (typeof nonce === "string") ctx.secrets.add(nonce);
  if (typeof controlMessage === "string") ctx.secrets.add(controlMessage);
  if (
    typeof sessionId !== "string" ||
    typeof nonce !== "string" ||
    typeof controlMessage !== "string" ||
    typeof text !== "string" ||
    typeof expiresAt !== "number"
  ) {
    throw new CheckFailure("POST /api/preflight/authorize: body is not { sessionId, nonce, controlMessage, text, expiresAt }");
  }
  if (!controlMessage.includes(nonce)) throw new CheckFailure("POST /api/preflight/authorize: controlMessage does not carry the nonce");
  if (text.trim() === "") throw new CheckFailure("POST /api/preflight/authorize: empty authorised text");
  return { sessionId, nonce, controlMessage, text, expiresAt };
}

/** Reads a required variable from the raw environment, or throws `CheckFailure` naming it (never its value). */
export function requireVars<K extends string>(
  env: Readonly<Record<string, string | undefined>>,
  names: readonly K[],
): Record<K, string> {
  const missing = names.filter((name) => (env[name]?.trim() ?? "") === "");
  if (missing.length > 0) throw new CheckFailure(`missing environment variable(s): ${missing.join(", ")}`);
  return Object.fromEntries(names.map((name) => [name, env[name]?.trim() ?? ""])) as Record<K, string>;
}
