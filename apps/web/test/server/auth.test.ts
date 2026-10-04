/**
 * Accounts and access (lib/auth, lib/server/auth): who may start which session, who may read and write
 * a session, sign-up and sign-in, the admin's account actions, the env admin, and the front door.
 */
import { readFileSync, readdirSync } from "node:fs";
import { join, relative } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { USER_ROLES, type UserRole } from "@vashistha/core";
import { openDatabase, type OpenedDatabase } from "@vashistha/core/server";
import { SERVED_CASE_SET_LIST, SESSION_STARTS, listableCaseSets, startRefusal } from "../../lib/auth/policy";
import { sessionRefusal } from "../../lib/server/auth/access";
import { pathAccess, gate, sameSite } from "../../lib/server/auth/gate";
import { handleAccountAction, handleListAccounts, handleSignIn, handleSignOut, handleSignUp, type AdminDeps } from "../../lib/server/auth/handlers";
import { hashPassword, hashPasswordSync, verifyPassword } from "../../lib/server/auth/passwords";
import { principalFrom, readCookie, SESSION_COOKIE } from "../../lib/server/auth/principal";
import { AUTH_SESSION_TTL_MS, bootstrapAdmin, createAccountStore, type Account, type AccountStore } from "../../lib/server/auth/store";
import { handleCreateSession } from "../../lib/server/casedesk/sessions";
import { createRateLimiter } from "../../lib/server/rate-limit";
import { T0, createCaseDeskHarness, jsonRequest, type CaseDeskHarness } from "../support/casedesk-harness";

const SECRET = "o".repeat(40);
const PASSWORD = "correct horse battery";

let opened: OpenedDatabase;
let accounts: AccountStore;
let now: number;
let deps: AdminDeps;
const quiet = { error: () => undefined, warn: () => undefined, info: () => undefined };

beforeEach(() => {
  opened = openDatabase({ memory: true });
  accounts = createAccountStore(opened.sqlite);
  now = T0;
  deps = {
    accounts,
    limits: { signIn: createRateLimiter({ limit: 3, windowMs: 60_000 }), signUp: createRateLimiter({ limit: 50, windowMs: 60_000 }) },
    now: () => now,
    log: quiet,
    expertSessions: () => 0,
  };
});
afterEach(() => opened.close());

/** An account created straight in the store, with a cheap real hash. */
async function account(username: string, role: UserRole, extra: { expertRequested?: boolean } = {}): Promise<Account> {
  const created = accounts.create({ username, displayName: username, role, expertRequested: extra.expertRequested ?? false, passwordHash: await hashPassword(PASSWORD) }, "signed_up", now);
  if (created === undefined) throw new Error("taken");
  return created;
}

function cookieOf(response: Response): string {
  const header = response.headers.get("set-cookie") ?? "";
  const token = readCookie(header.split(";")[0], SESSION_COOKIE);
  if (token === undefined) throw new Error(`no session cookie in ${header}`);
  return token;
}

describe("policy: who may start which session", () => {
  it("an expert captures on the training set only; trainees and admins practise or take the held-out assessment", () => {
    const allowed = (role: UserRole) =>
      (["expert", "novice"] as const).flatMap((mode) => SERVED_CASE_SET_LIST.filter((set) => startRefusal(role, mode, set) === undefined).map((set) => `${mode}/${set}`));
    expect(allowed("expert")).toEqual(["expert/training"]);
    expect(allowed("trainee")).toEqual(["novice/practice", "novice/heldout"]);
    expect(allowed("admin")).toEqual(["novice/practice", "novice/heldout"]);
  });

  it("every refusal says why, and the table matches what the launcher starts", () => {
    expect(startRefusal("expert", "expert", "heldout")).toMatch(/unseen/);
    expect(startRefusal("trainee", "expert", "training")).toMatch(/admin grants the expert role/);
    expect(startRefusal("admin", "expert", "training")).toMatch(/never capture/);
    expect(startRefusal("trainee", "novice", "training")).toMatch(/experts' capture set/);
    for (const role of USER_ROLES) for (const set of SESSION_STARTS[role].caseSets) expect(startRefusal(role, SESSION_STARTS[role].mode, set)).toBeUndefined();
    expect(listableCaseSets("admin")).toEqual(SERVED_CASE_SET_LIST);
    expect(listableCaseSets("expert")).toEqual(["training"]);
  });
});

describe("session access: the owner writes; the owner, admins and the operator read", () => {
  const user = (id: string, role: UserRole) => ({ kind: "user" as const, account: { id, role } as Account });
  const owned = (userId: string, role: UserRole, mode: "expert" | "novice") => ({ owner: { userId, username: `u-${userId}`, role }, mode });

  it("the owner reads and writes while their role still permits the session's mode", () => {
    expect(sessionRefusal(user("a", "expert"), owned("a", "expert", "expert"), "write")).toBeUndefined();
    expect(sessionRefusal(user("a", "expert"), owned("a", "expert", "expert"), "read")).toBeUndefined();
    // Demoted: their words are no longer an expert's confirmations.
    expect(sessionRefusal(user("a", "trainee"), owned("a", "expert", "expert"), "write")).toMatch(/no longer permits/);
    expect(sessionRefusal(user("a", "trainee"), owned("a", "expert", "expert"), "read")).toBeUndefined();
  });

  it("another account neither reads nor writes; an admin reads but never writes; the operator only reads", () => {
    expect(sessionRefusal(user("b", "expert"), owned("a", "expert", "expert"), "read")).toMatch(/another account/);
    expect(sessionRefusal(user("b", "trainee"), owned("a", "trainee", "novice"), "write")).toMatch(/another account/);
    expect(sessionRefusal(user("z", "admin"), owned("a", "expert", "expert"), "read")).toBeUndefined();
    expect(sessionRefusal(user("z", "admin"), owned("a", "expert", "expert"), "write")).toMatch(/never write/);
    expect(sessionRefusal({ kind: "operator" }, owned("a", "expert", "expert"), "read")).toBeUndefined();
    expect(sessionRefusal({ kind: "operator" }, owned("a", "expert", "expert"), "write")).toMatch(/read-only/);
  });

  it("a session from before accounts is read-only to everyone", () => {
    expect(sessionRefusal(user("z", "admin"), { owner: undefined, mode: "expert" }, "read")).toBeUndefined();
    expect(sessionRefusal(user("a", "expert"), { owner: undefined, mode: "expert" }, "read")).toMatch(/another account/);
    expect(sessionRefusal(user("a", "expert"), { owner: undefined, mode: "expert" }, "write")).toMatch(/predates accounts/);
  });
});

describe("passwords", () => {
  it("scrypt hashes verify, are salted, and reject a wrong password or a foreign value", async () => {
    const a = await hashPassword(PASSWORD);
    expect(a).toMatch(/^scrypt\$32768\$8\$1\$/);
    expect(await hashPassword(PASSWORD)).not.toBe(a);
    expect(await verifyPassword(PASSWORD, a)).toBe(true);
    expect(await verifyPassword(PASSWORD, hashPasswordSync(PASSWORD))).toBe(true);
    expect(await verifyPassword("wrong password!", a)).toBe(false);
    expect(await verifyPassword(PASSWORD, "plaintext")).toBe(false);
  });
});

describe("sign-up and sign-in", () => {
  it("sign-up creates a signed-in TRAINEE, even when expert access is requested", async () => {
    const response = await handleSignUp(jsonRequest("/api/auth/signup", { username: "asha-rao", displayName: "Asha Rao", password: PASSWORD, requestExpert: true }), deps);
    expect(response.status).toBe(201);
    expect(await response.json()).toMatchObject({ viewer: { username: "asha-rao", role: "trainee", expertRequested: true } });
    expect(response.headers.get("set-cookie")).toMatch(/HttpOnly; SameSite=Lax; Max-Age=604800$/);
    expect(accounts.resolve(cookieOf(response), now)?.username).toBe("asha-rao");
    expect(accounts.byUsername("asha-rao")?.passwordHash).not.toContain(PASSWORD);
  });

  it("refuses a taken username, a non-slug username and a short password", async () => {
    await account("asha-rao", "trainee");
    const taken = await handleSignUp(jsonRequest("/api/auth/signup", { username: "asha-rao", displayName: "Other", password: PASSWORD }), deps);
    expect(taken.status).toBe(409);
    for (const body of [
      { username: "Asha Rao", displayName: "A", password: PASSWORD },
      { username: "ab", displayName: "A", password: PASSWORD },
      { username: "priya", displayName: "P", password: "short" },
      { username: "priya", displayName: "P", password: PASSWORD, role: "admin" },
    ])
      expect((await handleSignUp(jsonRequest("/api/auth/signup", body), deps)).status).toBe(400);
  });

  it("a wrong password and an unknown username get the same 401; only failures count toward the pause", async () => {
    await account("asha-rao", "expert");
    const wrong = await handleSignIn(jsonRequest("/api/auth/login", { username: "asha-rao", password: "not the password" }), deps);
    const unknown = await handleSignIn(jsonRequest("/api/auth/login", { username: "nobody", password: "not the password" }), deps);
    expect([wrong.status, unknown.status]).toEqual([401, 401]);
    expect(await wrong.json()).toEqual(await unknown.json());
    // Many successful sign-ins never pause the account (limit 3 failures).
    for (let i = 0; i < 5; i += 1) expect((await handleSignIn(jsonRequest("/api/auth/login", { username: " Asha-Rao ", password: PASSWORD }), deps)).status).toBe(200);
    await handleSignIn(jsonRequest("/api/auth/login", { username: "asha-rao", password: "x" }), deps);
    await handleSignIn(jsonRequest("/api/auth/login", { username: "asha-rao", password: "y" }), deps);
    const paused = await handleSignIn(jsonRequest("/api/auth/login", { username: "asha-rao", password: PASSWORD }), deps);
    expect(paused.status).toBe(429);
  });

  it("a sign-in expires, ends at sign-out, and ends when the account is disabled", async () => {
    const admin = await account("root", "admin");
    const asha = await account("asha-rao", "expert");
    const token = cookieOf(await handleSignIn(jsonRequest("/api/auth/login", { username: "asha-rao", password: PASSWORD }), deps));
    expect(accounts.resolve(token, now + AUTH_SESSION_TTL_MS - 1)?.id).toBe(asha.id);
    expect(accounts.resolve(token, now + AUTH_SESSION_TTL_MS)).toBeUndefined();

    const signOut = await handleSignOut(new Request("http://localhost/api/auth/logout", { method: "POST", headers: { cookie: `${SESSION_COOKIE}=${token}` } }), deps);
    expect(signOut.headers.get("set-cookie")).toMatch(/Max-Age=0/);
    expect(accounts.resolve(token, now)).toBeUndefined();

    const again = cookieOf(await handleSignIn(jsonRequest("/api/auth/login", { username: "asha-rao", password: PASSWORD }), deps));
    accounts.setDisabled(asha.id, true, admin.id, now);
    expect(accounts.resolve(again, now)).toBeUndefined();
    const refused = await handleSignIn(jsonRequest("/api/auth/login", { username: "asha-rao", password: PASSWORD }), deps);
    expect(refused.status).toBe(403);
  });

  it("only a digest of the token is stored", async () => {
    await account("asha-rao", "trainee");
    const token = cookieOf(await handleSignIn(jsonRequest("/api/auth/login", { username: "asha-rao", password: PASSWORD }), deps));
    const rows = opened.sqlite.prepare("SELECT token_hash FROM auth_sessions").all() as { token_hash: string }[];
    expect(rows).toHaveLength(1);
    expect(rows[0]?.token_hash).not.toBe(token);
    expect(rows[0]?.token_hash).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe("admin: granting roles", () => {
  const act = (userId: string, actor: Account, body: unknown) => handleAccountAction(jsonRequest(`/api/admin/users/${userId}`, body), userId, actor, deps);

  it("granting expert settles the request and is audited with the admin's name", async () => {
    const admin = await account("root", "admin");
    const asha = await account("asha-rao", "trainee", { expertRequested: true });
    const response = await act(asha.id, admin, { action: "set_role", role: "expert" });
    expect(response.status).toBe(200);
    expect(accounts.byId(asha.id)).toMatchObject({ role: "expert", expertRequested: false });
    expect(accounts.events()[0]).toMatchObject({ kind: "role_changed", actor: "root", subject: "asha-rao", detail: { from: "trainee", to: "expert" } });
  });

  it("an admin cannot change their own account, and unchanged or unknown targets are refused", async () => {
    const admin = await account("root", "admin");
    const asha = await account("asha-rao", "expert");
    expect((await act(admin.id, admin, { action: "set_role", role: "trainee" })).status).toBe(409);
    expect((await act(admin.id, admin, { action: "set_disabled", disabled: true })).status).toBe(409);
    expect((await act(asha.id, admin, { action: "set_role", role: "expert" })).status).toBe(409);
    expect((await act(asha.id, admin, { action: "decline_expert" })).status).toBe(409);
    expect((await act("no-such-user", admin, { action: "set_disabled", disabled: true })).status).toBe(404);
  });

  it("the audit trail is append-only and a role outside the set cannot be stored", async () => {
    const admin = await account("root", "admin");
    expect(() => opened.sqlite.prepare("DELETE FROM account_events").run()).toThrow(/append-only/);
    expect(() => opened.sqlite.prepare("UPDATE account_events SET kind = 'x'").run()).toThrow(/append-only/);
    expect(() => opened.sqlite.prepare("UPDATE users SET role = 'superuser' WHERE id = ?").run(admin.id)).toThrow(/users.role/);
    expect(() => opened.sqlite.prepare("UPDATE users SET username = 'other' WHERE id = ?").run(admin.id)).toThrow(/immutable/);
  });

  it("lists accounts with sessions already recorded under their expert id", async () => {
    await account("asha-rao", "trainee", { expertRequested: true });
    const response = await handleListAccounts({ ...deps, expertSessions: (id) => (id === "asha-rao" ? 2 : 0) });
    expect(await response.json()).toMatchObject({ users: [{ username: "asha-rao", expertSessions: 2 }], events: [{ kind: "signed_up" }] });
  });
});

describe("the env admin", () => {
  it("is created once and never overwritten", () => {
    bootstrapAdmin(accounts, { username: "root", passwordHash: () => hashPasswordSync(PASSWORD) }, now, quiet);
    const first = accounts.byUsername("root");
    expect(first?.role).toBe("admin");
    bootstrapAdmin(accounts, { username: "root", passwordHash: () => hashPasswordSync("another password") }, now, quiet);
    expect(accounts.byUsername("root")?.passwordHash).toBe(first?.passwordHash);
  });

  it("never promotes an account someone else signed up under that name", async () => {
    await account("root", "trainee");
    const errors: string[] = [];
    bootstrapAdmin(accounts, { username: "root", passwordHash: () => hashPasswordSync(PASSWORD) }, now, { ...quiet, error: (m: string) => errors.push(m) });
    expect(accounts.byUsername("root")?.role).toBe("trainee");
    expect(errors[0]).toMatch(/NOT promoted/);
  });
});

describe("the front door", () => {
  it("classifies paths", () => {
    expect(["/", "/login", "/signup", "/api/auth/login", "/api/health", "/replay", "/replay/abc", "/api/replays", "/api/replays/abc/views", "/_next/static/x.js", "/tesseract/worker.min.js"].map(pathAccess)).toEqual(
      Array(11).fill("public"),
    );
    expect(["/api/llm/chat/completions", "/api/health/deep", "/api/health/disk", "/api/preflight/authorize", "/api/sessions/s1/archive"].map(pathAccess)).toEqual(Array(5).fill("bearer"));
    expect(["/sandbox", "/admin", "/debrief/s1", "/api/sessions", "/api/sessions/s1/ledger", "/api/rulebook", "/replays-elsewhere", "/api/auth/me"].map(pathAccess)).toEqual(Array(8).fill("principal"));
  });

  it("redirects a page and refuses an API without a principal; passes a signed-in user and the operator", async () => {
    const asha = await account("asha-rao", "trainee");
    const token = accounts.signIn(asha.id, now);
    const door = (url: string, headers: Record<string, string> = {}, method = "GET") =>
      gate({ method, url, headers }, { accounts, operatorSecret: SECRET, publicBaseUrl: "https://casedesk.example", now });
    expect(door("/debrief/s1?x=1")).toEqual({ kind: "sign_in", location: "/login?next=%2Fdebrief%2Fs1%3Fx%3D1" });
    expect(door("/api/sessions/s1/ledger")).toEqual({ kind: "unauthenticated" });
    expect(door("/api/sessions/s1/ledger", { cookie: `${SESSION_COOKIE}=forged` })).toEqual({ kind: "unauthenticated" });
    expect(door("/sandbox", { cookie: `other=1; ${SESSION_COOKIE}=${token}` })).toMatchObject({ kind: "pass", principal: { kind: "user", account: { username: "asha-rao" } } });
    expect(door("/api/sessions/s1/ledger", { authorization: `Bearer ${SECRET}` })).toMatchObject({ kind: "pass", principal: { kind: "operator" } });
    expect(door("/api/llm/chat/completions", {}, "POST")).toEqual({ kind: "pass", principal: undefined });
  });

  it("refuses a cookie-carrying write from another site", async () => {
    const asha = await account("asha-rao", "trainee");
    const cookie = `${SESSION_COOKIE}=${accounts.signIn(asha.id, now)}`;
    const write = (headers: Record<string, string>) =>
      gate({ method: "POST", url: "/api/sessions", headers: { cookie, host: "casedesk.example", ...headers } }, { accounts, operatorSecret: SECRET, publicBaseUrl: "https://casedesk.example", now });
    expect(write({ origin: "https://evil.example" })).toEqual({ kind: "cross_site" });
    expect(write({ "sec-fetch-site": "cross-site" })).toEqual({ kind: "cross_site" });
    expect(write({ origin: "https://casedesk.example" }).kind).toBe("pass");
    expect(write({}).kind).toBe("pass");
    expect(sameSite({ origin: "http://127.0.0.1:4391", host: "127.0.0.1:4391" }, "https://casedesk-e2e.invalid")).toBe(true);
  });

  it("resolves a principal from a cookie before the bearer", async () => {
    const asha = await account("asha-rao", "trainee");
    const token = accounts.signIn(asha.id, now);
    expect(principalFrom({ cookie: `${SESSION_COOKIE}=${token}`, authorization: `Bearer ${SECRET}` }, { accounts, operatorSecret: SECRET, now })).toMatchObject({ kind: "user" });
    expect(principalFrom({ cookie: undefined, authorization: "Bearer wrong" }, { accounts, operatorSecret: SECRET, now })).toBeUndefined();
    expect(principalFrom({ cookie: undefined, authorization: `Bearer ${SECRET}` }, { accounts, operatorSecret: undefined, now })).toBeUndefined();
  });
});

describe("POST /api/sessions under the real policy", () => {
  let h: CaseDeskHarness;
  beforeEach(() => {
    h = createCaseDeskHarness();
  });
  afterEach(() => h.opened.close());

  const actor = (role: UserRole, username = `${role}-one`) => ({ id: `id-${username}`, username, displayName: `Name of ${username}`, role });
  const start = (body: unknown, who: ReturnType<typeof actor>) => handleCreateSession(jsonRequest("/api/sessions", body), h.deps, who);

  it("the expert is the signed-in account, and the owner is recorded in the ledger", async () => {
    const response = await start({ mode: "expert", caseSet: "training", language: "hi" }, actor("expert", "asha-rao"));
    expect(response.status).toBe(201);
    const { sessionId, expert } = (await response.json()) as { sessionId: string; expert: unknown };
    expect(expert).toEqual({ id: "asha-rao", name: "Name of asha-rao", language: "hi" });
    expect(h.ledger.list(sessionId)[0]?.payload).toMatchObject({ owner: { userId: "id-asha-rao", username: "asha-rao", role: "expert" } });
  });

  it.each([
    ["an expert capturing held-out cases", "expert", { mode: "expert", caseSet: "heldout" }],
    ["an expert practising", "expert", { mode: "novice", caseSet: "practice" }],
    ["a trainee capturing", "trainee", { mode: "expert", caseSet: "training" }],
    ["a trainee on the training set", "trainee", { mode: "novice", caseSet: "training" }],
    ["an admin capturing", "admin", { mode: "expert", caseSet: "training" }],
  ] as const)("403 for %s, creating nothing", async (_name, role, body) => {
    const response = await start(body, actor(role));
    expect(response.status).toBe(403);
    expect(await response.json()).toMatchObject({ error: "not_permitted" });
    expect(h.opened.sqlite.prepare("SELECT count(*) AS n FROM sessions").get()).toEqual({ n: 0 });
  });

  it("a typed expert name is no longer accepted: identity comes from the account", async () => {
    const response = await start({ mode: "expert", caseSet: "training", expert: { name: "Somebody Else" } }, actor("expert"));
    expect(response.status).toBe(400);
  });
});

describe("every API route is guarded", () => {
  /** Routes that are public, or check the operator bearer themselves; everything else must call a guard. */
  const UNGUARDED: Record<string, string> = {
    "auth/signup": "public: creates a trainee",
    "auth/login": "public",
    "auth/logout": "public: ends this browser's sign-in",
    health: "public",
    "health/deep": "bearer",
    "health/disk": "bearer",
    "llm/chat/completions": "bearer (ElevenLabs)",
    "preflight/authorize": "bearer",
    "sessions/[sessionId]/archive": "bearer (operator)",
    replays: "public: verified replays",
    "replays/[bundleId]": "public",
    "replays/[bundleId]/views": "public",
    "replays/[bundleId]/audio/[file]": "public",
    "replays/[bundleId]/media/[...path]": "public",
    "replays/[bundleId]/import": "bearer",
    "replays/[bundleId]/import/[...path]": "bearer",
  };
  const API = join(import.meta.dirname, "../../app/api");
  const routes = (dir: string): string[] =>
    readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? routes(join(dir, e.name)) : e.name === "route.ts" ? [join(dir, e.name)] : []));

  it("each route calls a guard from lib/server/auth/access, or is listed as public or bearer-checked", () => {
    const all = routes(API).map((file) => ({ route: relative(API, file).replace(/\/route\.ts$/, ""), source: readFileSync(file, "utf8") }));
    expect(all.length).toBeGreaterThan(40);
    for (const { route, source } of all) {
      const guarded = source.includes('from "@/lib/server/auth/access"') && /\b(guard|guardSession|guardSessionInBody|guardDisagreement\w+)\(/.test(source);
      expect(guarded !== route in UNGUARDED, `${route}: ${guarded ? "guarded but listed as unguarded" : "calls no guard; guard it or list it in UNGUARDED"}`).toBe(true);
      // Every exported handler of a guarded route goes through the guard.
      if (guarded) for (const handler of source.match(/export (?:async )?function \w+/g) ?? []) expect(source.split(handler)[1]?.split(/\nexport /)[0], `${route} ${handler}`).toMatch(/guard\w*\(/);
    }
  });
});
