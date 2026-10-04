/**
 * Who is asking. A browser is a signed-in account (the `vashistha_session` cookie); the team's
 * scripts may present the operator bearer (`CUSTOM_LLM_SECRET`), which READS everything — replay
 * export needs every session's ledger — and writes nothing in anyone's name.
 */
import type { Account, AccountStore } from "./store";
import { bearerMatches } from "../bearer";

export const SESSION_COOKIE = "vashistha_session";

export type Principal = { kind: "user"; account: Account } | { kind: "operator" };

/** The value of cookie `name` in a `Cookie` header. */
export function readCookie(header: string | null | undefined, name: string): string | undefined {
  for (const part of (header ?? "").split(";")) {
    const eq = part.indexOf("=");
    if (eq !== -1 && part.slice(0, eq).trim() === name) return part.slice(eq + 1).trim() || undefined;
  }
  return undefined;
}

export type CredentialHeaders = { cookie: string | null | undefined; authorization: string | null | undefined };

export function principalFrom(
  headers: CredentialHeaders,
  deps: { accounts: AccountStore; operatorSecret: string | undefined; now: number },
): Principal | undefined {
  const token = readCookie(headers.cookie, SESSION_COOKIE);
  const account = token === undefined ? undefined : deps.accounts.resolve(token, deps.now);
  if (account !== undefined) return { kind: "user", account };
  if (bearerMatches(headers.authorization, deps.operatorSecret)) return { kind: "operator" };
  return undefined;
}

export function credentialHeaders(headers: Headers): CredentialHeaders {
  return { cookie: headers.get("cookie"), authorization: headers.get("authorization") };
}

/**
 * Railway terminates TLS and sets `X-Forwarded-Proto: https`; a local http run (dev, e2e) gets a
 * cookie without `Secure`, which a browser would otherwise refuse to send back over http.
 */
export function isHttps(headers: Headers): boolean {
  return headers.get("x-forwarded-proto")?.split(",")[0]?.trim() === "https";
}

/** HttpOnly (no script can read it), SameSite=Lax (not sent on cross-site POSTs). */
export function sessionCookie(token: string, maxAgeS: number, secure: boolean): string {
  return `${SESSION_COOKIE}=${token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAgeS}${secure ? "; Secure" : ""}`;
}

export function clearedSessionCookie(secure: boolean): string {
  return sessionCookie("", 0, secure);
}
