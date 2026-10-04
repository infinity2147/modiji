/**
 * Accounts over HTTP: `POST /api/auth/signup|login|logout`, `GET /api/auth/me`, and the admin's
 * `GET /api/admin/users` and `POST /api/admin/users/:userId`. Sign-up always creates a trainee; only
 * an admin grants a role, and every grant is written to the append-only `account_events`.
 */
import type { z } from "zod";
import {
  AdminActionRequestSchema,
  LoginRequestSchema,
  SignupRequestSchema,
  type AdminUsersResponseSchema,
  type Viewer,
  type ViewerResponseSchema,
} from "../../contracts/auth";
import { ApiFailure, json, readJson, respond } from "../casedesk/http";
import { clientKey, type RateLimiter } from "../rate-limit";
import { dummyPasswordHash, hashPassword, verifyPassword } from "./passwords";
import { clearedSessionCookie, isHttps, readCookie, SESSION_COOKIE, sessionCookie } from "./principal";
import { AUTH_SESSION_TTL_MS, type Account, type AccountStore } from "./store";

export type AuthDeps = {
  accounts: AccountStore;
  limits: { signIn: RateLimiter; signUp: RateLimiter };
  now: () => number;
  log: Pick<Console, "error" | "warn">;
};

export function viewerOf(account: Account): Viewer {
  return { id: account.id, username: account.username, displayName: account.displayName, role: account.role, expertRequested: account.expertRequested };
}

function rateLimited(retryAfterS: number): never {
  throw new ApiFailure(429, "rate_limited", `too many attempts; try again in ${retryAfterS} s`);
}

/** The viewer, with a fresh sign-in cookie. */
function signedIn(request: Request, deps: AuthDeps, account: Account, status: number): Response {
  const token = deps.accounts.signIn(account.id, deps.now());
  const body: z.infer<typeof ViewerResponseSchema> = { viewer: viewerOf(account) };
  const response = json(body, status);
  response.headers.set("Set-Cookie", sessionCookie(token, AUTH_SESSION_TTL_MS / 1000, isHttps(request.headers)));
  return response;
}

/** POST /api/auth/signup — a trainee account, signed in. */
export function handleSignUp(request: Request, deps: AuthDeps): Promise<Response> {
  return respond(deps.log, async () => {
    const limited = deps.limits.signUp.take(clientKey(request.headers), deps.now());
    if (!limited.ok) rateLimited(limited.retryAfterS);
    const req = await readJson(request, SignupRequestSchema);
    const account = deps.accounts.create(
      { username: req.username, displayName: req.displayName, role: "trainee", expertRequested: req.requestExpert, passwordHash: await hashPassword(req.password) },
      "signed_up",
      deps.now(),
    );
    if (account === undefined) throw new ApiFailure(409, "username_taken", "that username is taken; choose another");
    return signedIn(request, deps, account, 201);
  });
}

/**
 * POST /api/auth/login. An unknown username and a wrong password get the same answer after the same
 * work; only failures count toward the pause, so signing in often never locks anyone out.
 */
export function handleSignIn(request: Request, deps: AuthDeps): Promise<Response> {
  return respond(deps.log, async () => {
    const req = await readJson(request, LoginRequestSchema);
    const key = `${clientKey(request.headers)}|${req.username}`;
    const limited = deps.limits.signIn.check(key, deps.now());
    if (!limited.ok) rateLimited(limited.retryAfterS);
    const account = deps.accounts.byUsername(req.username);
    const valid = await verifyPassword(req.password, account?.passwordHash ?? (await dummyPasswordHash()));
    if (account === undefined || !valid) {
      deps.limits.signIn.take(key, deps.now());
      throw new ApiFailure(401, "invalid_credentials", "wrong username or password");
    }
    if (account.disabledAt !== null) throw new ApiFailure(403, "account_disabled", "this account is disabled; ask an admin");
    return signedIn(request, deps, account, 200);
  });
}

/** POST /api/auth/logout — ends this sign-in (always succeeds). */
export function handleSignOut(request: Request, deps: Pick<AuthDeps, "accounts" | "log">): Promise<Response> {
  return respond(deps.log, () => {
    const token = readCookie(request.headers.get("cookie"), SESSION_COOKIE);
    if (token !== undefined) deps.accounts.signOut(token);
    const response = json({ ok: true });
    response.headers.set("Set-Cookie", clearedSessionCookie(isHttps(request.headers)));
    return response;
  });
}

export type AdminDeps = AuthDeps & {
  /** Expert capture sessions recorded under an expert id (sessions from before accounts included). */
  expertSessions: (expertId: string) => number;
};

function adminState(deps: AdminDeps): z.infer<typeof AdminUsersResponseSchema> {
  return {
    users: deps.accounts.list().map((a) => ({
      ...viewerOf(a),
      createdAt: a.createdAt,
      disabled: a.disabledAt !== null,
      expertSessions: deps.expertSessions(a.username),
    })),
    events: deps.accounts.events(),
  };
}

/** GET /api/admin/users */
export function handleListAccounts(deps: AdminDeps): Promise<Response> {
  return respond(deps.log, () => json(adminState(deps)));
}

/** POST /api/admin/users/:userId — `actor` is the signed-in admin. */
export function handleAccountAction(request: Request, userId: string, actor: Account, deps: AdminDeps): Promise<Response> {
  return respond(deps.log, async () => {
    const req = await readJson(request, AdminActionRequestSchema);
    const subject = deps.accounts.byId(userId);
    if (subject === undefined) throw new ApiFailure(404, "account_not_found", "no account with this id");
    // Also keeps at least one admin: the acting admin can neither demote nor disable themselves.
    if (subject.id === actor.id) throw new ApiFailure(409, "own_account", "ask another admin to change your own account");
    const now = deps.now();
    switch (req.action) {
      case "set_role":
        if (subject.role === req.role) throw new ApiFailure(409, "unchanged", `${subject.username} is already ${req.role === "admin" ? "an" : "a"} ${req.role}`);
        deps.accounts.setRole(subject.id, req.role, actor.id, now);
        break;
      case "decline_expert":
        if (!subject.expertRequested) throw new ApiFailure(409, "no_request", `${subject.username} has no pending expert request`);
        deps.accounts.declineExpert(subject.id, actor.id, now);
        break;
      case "set_disabled":
        if ((subject.disabledAt !== null) === req.disabled) throw new ApiFailure(409, "unchanged", `${subject.username} is already ${req.disabled ? "disabled" : "enabled"}`);
        deps.accounts.setDisabled(subject.id, req.disabled, actor.id, now);
        break;
    }
    return json(adminState(deps));
  });
}
