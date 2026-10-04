/**
 * The front door, run by `server.ts` on every request before Next sees it: who may reach a path at
 * all. Route handlers then decide what the principal may do there (`access.ts`), so a route that
 * forgot its guard is still closed to anyone not signed in.
 *
 * - Public: sign-in and sign-up, health, static assets, and the verified replays (archived,
 *   integrity-checked recordings of synthetic runs, the demo's fallback when the network fails).
 * - Self-authenticating: machine endpoints that check the operator bearer themselves.
 * - Everything else needs a principal: a page redirects to /login, an API answers 401.
 *
 * A cookie-authenticated write must come from this site: a cross-site Origin is refused (SameSite=Lax
 * already withholds the cookie from cross-site POSTs; this is the second lock).
 */
import type { IncomingHttpHeaders, IncomingMessage } from "node:http";
import { principalFrom, readCookie, SESSION_COOKIE, type Principal } from "./principal";
import type { AccountStore } from "./store";

const PUBLIC_PATHS = new Set(["/", "/login", "/signup", "/api/auth/login", "/api/auth/signup", "/api/auth/logout", "/api/health", "/favicon.ico"]);
/** `/__nextjs…`: the development overlay's own requests (absent in production). */
const PUBLIC_PREFIXES = ["/_next/", "/__nextjs", "/tesseract/", "/replay/", "/api/replays/"];
const PUBLIC_EXACT_PREFIX_ROOTS = new Set(["/replay", "/api/replays"]);
/** Checked by their own handlers against the operator bearer (CUSTOM_LLM_SECRET). */
const BEARER_PREFIXES = ["/api/llm/", "/api/preflight/", "/api/health/deep", "/api/health/disk"];
const ARCHIVE = /^\/api\/sessions\/[^/]+\/archive$/;

export type PathAccess = "public" | "bearer" | "principal";

export function pathAccess(pathname: string): PathAccess {
  if (PUBLIC_PATHS.has(pathname) || PUBLIC_EXACT_PREFIX_ROOTS.has(pathname) || PUBLIC_PREFIXES.some((p) => pathname.startsWith(p))) return "public";
  if (BEARER_PREFIXES.some((p) => pathname.startsWith(p)) || ARCHIVE.test(pathname)) return "bearer";
  return "principal";
}

const SAFE_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);

function first(value: string | string[] | undefined): string | undefined {
  return (Array.isArray(value) ? value[0] : value)?.split(",")[0]?.trim();
}

/** False when a browser says the request came from another site. Requests without Origin (scripts) pass. */
export function sameSite(headers: IncomingHttpHeaders, publicBaseUrl: string): boolean {
  if (first(headers["sec-fetch-site"]) === "cross-site") return false;
  const origin = first(headers.origin);
  if (origin === undefined) return true;
  let host: string;
  try {
    host = new URL(origin).host;
  } catch {
    return false;
  }
  const own = [first(headers.host), first(headers["x-forwarded-host"]), new URL(publicBaseUrl).host];
  return own.includes(host);
}

export type GateVerdict =
  | { kind: "pass"; principal: Principal | undefined }
  | { kind: "unauthenticated" }
  | { kind: "sign_in"; location: string }
  | { kind: "cross_site" };

export function gate(
  req: Pick<IncomingMessage, "method" | "url" | "headers">,
  deps: { accounts: AccountStore; operatorSecret: string | undefined; publicBaseUrl: string; now: number },
): GateVerdict {
  const url = new URL(req.url ?? "/", "http://localhost");
  const access = pathAccess(url.pathname);
  const { cookie, authorization } = req.headers;
  if (!SAFE_METHODS.has(req.method ?? "GET") && readCookie(cookie, SESSION_COOKIE) !== undefined && !sameSite(req.headers, deps.publicBaseUrl))
    return { kind: "cross_site" };
  if (access !== "principal") return { kind: "pass", principal: undefined };
  const principal = principalFrom({ cookie, authorization }, { accounts: deps.accounts, operatorSecret: deps.operatorSecret, now: deps.now });
  if (principal !== undefined) return { kind: "pass", principal };
  if (url.pathname.startsWith("/api/")) return { kind: "unauthenticated" };
  return { kind: "sign_in", location: `/login?next=${encodeURIComponent(url.pathname + url.search)}` };
}
