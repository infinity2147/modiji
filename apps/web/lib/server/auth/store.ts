/**
 * Accounts and sign-ins over SQLite (tables from migration 0003). Only `runtime-init.ts` and test
 * harnesses create it; route handlers reach it through the runtime. Every role or status change is
 * written together with its `account_events` row in one transaction.
 */
import "server-only";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import type { UserRole } from "@vashistha/core";
import type { OpenedDatabase } from "@vashistha/core/server";

type Sqlite = OpenedDatabase["sqlite"];

/** A sign-in lasts a week; signing out or disabling the account ends it sooner. */
export const AUTH_SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000;

export type Account = {
  id: string;
  username: string;
  displayName: string;
  role: UserRole;
  expertRequested: boolean;
  passwordHash: string;
  createdAt: number;
  disabledAt: number | null;
};

export type AccountEventKind = "signed_up" | "bootstrapped" | "role_changed" | "expert_declined" | "disabled" | "enabled";

export type AccountEventRecord = {
  id: string;
  at: number;
  actor: string | null;
  subject: string;
  kind: AccountEventKind;
  detail: Record<string, unknown>;
};

type UserRow = {
  id: string;
  username: string;
  display_name: string;
  role: UserRole;
  expert_requested: number;
  password_hash: string;
  created_at: number;
  disabled_at: number | null;
};

type EventRow = { id: string; at: number; actor: string | null; subject: string; kind: AccountEventKind; detail: string };

function toAccount(row: UserRow): Account {
  return {
    id: row.id,
    username: row.username,
    displayName: row.display_name,
    role: row.role,
    expertRequested: row.expert_requested === 1,
    passwordHash: row.password_hash,
    createdAt: row.created_at,
    disabledAt: row.disabled_at,
  };
}

/** Only this digest of a sign-in token is stored. */
export function tokenDigest(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

export type NewAccount = { username: string; displayName: string; role: UserRole; expertRequested: boolean; passwordHash: string };

export type AccountStore = ReturnType<typeof createAccountStore>;

export function createAccountStore(sqlite: Sqlite) {
  const USER_COLUMNS = "id, username, display_name, role, expert_requested, password_hash, created_at, disabled_at";
  const byUsername = sqlite.prepare<[string], UserRow>(`SELECT ${USER_COLUMNS} FROM users WHERE username = ?`);
  const byId = sqlite.prepare<[string], UserRow>(`SELECT ${USER_COLUMNS} FROM users WHERE id = ?`);
  const all = sqlite.prepare<[], UserRow>(`SELECT ${USER_COLUMNS} FROM users ORDER BY created_at, username`);
  const insertUser = sqlite.prepare(
    "INSERT INTO users (id, username, display_name, role, expert_requested, password_hash, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
  );
  const updateRole = sqlite.prepare<[UserRole, string]>("UPDATE users SET role = ?, expert_requested = 0 WHERE id = ?");
  const clearRequest = sqlite.prepare<[string]>("UPDATE users SET expert_requested = 0 WHERE id = ?");
  const updateDisabled = sqlite.prepare<[number | null, string]>("UPDATE users SET disabled_at = ? WHERE id = ?");
  const activeAdmins = sqlite.prepare<[], { n: number }>("SELECT COUNT(*) AS n FROM users WHERE role = 'admin' AND disabled_at IS NULL");
  const insertEvent = sqlite.prepare("INSERT INTO account_events (id, at, actor_id, subject_id, kind, detail) VALUES (?, ?, ?, ?, ?, ?)");
  const recentEvents = sqlite.prepare<[number], EventRow>(
    `SELECT e.id, e.at, a.username AS actor, s.username AS subject, e.kind, e.detail
       FROM account_events e JOIN users s ON s.id = e.subject_id LEFT JOIN users a ON a.id = e.actor_id
      ORDER BY e.rowid DESC LIMIT ?`,
  );
  const insertSession = sqlite.prepare("INSERT INTO auth_sessions (token_hash, user_id, created_at, expires_at) VALUES (?, ?, ?, ?)");
  const sessionUser = sqlite.prepare<[string, number], UserRow>(
    `SELECT u.id, u.username, u.display_name, u.role, u.expert_requested, u.password_hash, u.created_at, u.disabled_at
       FROM auth_sessions s JOIN users u ON u.id = s.user_id
      WHERE s.token_hash = ? AND s.expires_at > ? AND u.disabled_at IS NULL`,
  );
  const deleteSession = sqlite.prepare<[string]>("DELETE FROM auth_sessions WHERE token_hash = ?");
  const deleteSessionsOf = sqlite.prepare<[string]>("DELETE FROM auth_sessions WHERE user_id = ?");
  const deleteExpired = sqlite.prepare<[number]>("DELETE FROM auth_sessions WHERE expires_at <= ?");

  const record = (at: number, actorId: string | null, subjectId: string, kind: AccountEventKind, detail: Record<string, unknown>): void => {
    insertEvent.run(randomUUID(), at, actorId, subjectId, kind, JSON.stringify(detail));
  };

  const get = (id: string): Account => {
    const row = byId.get(id);
    if (row === undefined) throw new Error(`no account ${id}`);
    return toAccount(row);
  };

  return {
    byUsername: (username: string): Account | undefined => {
      const row = byUsername.get(username);
      return row && toAccount(row);
    },
    byId: (id: string): Account | undefined => {
      const row = byId.get(id);
      return row && toAccount(row);
    },
    list: (): Account[] => all.all().map(toAccount),
    events: (limit = 100): AccountEventRecord[] =>
      recentEvents.all(limit).map((e) => ({ ...e, detail: JSON.parse(e.detail) as Record<string, unknown> })),
    activeAdminCount: (): number => activeAdmins.get()?.n ?? 0,

    /** Undefined when the username is taken. */
    create: sqlite.transaction((input: NewAccount, kind: "signed_up" | "bootstrapped", now: number): Account | undefined => {
      if (byUsername.get(input.username) !== undefined) return undefined;
      const id = randomUUID();
      insertUser.run(id, input.username, input.displayName, input.role, input.expertRequested ? 1 : 0, input.passwordHash, now);
      record(now, null, id, kind, { role: input.role, ...(input.expertRequested && { expertRequested: true }) });
      return get(id);
    }),

    /** Granting or changing a role also settles a pending expert request. */
    setRole: sqlite.transaction((subjectId: string, role: UserRole, actorId: string, now: number): Account => {
      const before = get(subjectId);
      updateRole.run(role, subjectId);
      record(now, actorId, subjectId, "role_changed", { from: before.role, to: role });
      return get(subjectId);
    }),

    declineExpert: sqlite.transaction((subjectId: string, actorId: string, now: number): Account => {
      clearRequest.run(subjectId);
      record(now, actorId, subjectId, "expert_declined", {});
      return get(subjectId);
    }),

    /** Disabling also ends every sign-in of the account. */
    setDisabled: sqlite.transaction((subjectId: string, disabled: boolean, actorId: string, now: number): Account => {
      updateDisabled.run(disabled ? now : null, subjectId);
      if (disabled) deleteSessionsOf.run(subjectId);
      record(now, actorId, subjectId, disabled ? "disabled" : "enabled", {});
      return get(subjectId);
    }),

    /** Returns the cookie token; only its digest is stored. */
    signIn: (userId: string, now: number): string => {
      deleteExpired.run(now);
      const token = randomBytes(32).toString("base64url");
      insertSession.run(tokenDigest(token), userId, now, now + AUTH_SESSION_TTL_MS);
      return token;
    },
    /** The enabled account a live sign-in token belongs to. */
    resolve: (token: string, now: number): Account | undefined => {
      const row = sessionUser.get(tokenDigest(token), now);
      return row && toAccount(row);
    },
    signOut: (token: string): void => {
      deleteSession.run(tokenDigest(token));
    },
  };
}

/**
 * The env admin (ADMIN_USERNAME / ADMIN_PASSWORD): created when no account has that username. An
 * existing account is never changed, so a password rotated in the app survives a restart, and an
 * account that someone else signed up under that name is never promoted.
 */
export function bootstrapAdmin(
  accounts: AccountStore,
  admin: { username: string; passwordHash: () => string } | undefined,
  now: number,
  log: Pick<Console, "info" | "warn" | "error">,
): void {
  if (admin === undefined) {
    if (accounts.activeAdminCount() === 0) log.warn("> accounts: no admin exists and ADMIN_USERNAME/ADMIN_PASSWORD are unset; nobody can grant the expert role");
    return;
  }
  const existing = accounts.byUsername(admin.username);
  if (existing === undefined) {
    accounts.create({ username: admin.username, displayName: "Administrator", role: "admin", expertRequested: false, passwordHash: admin.passwordHash() }, "bootstrapped", now);
    log.info(`> accounts: admin "${admin.username}" created from ADMIN_USERNAME`);
  } else if (existing.role !== "admin") {
    log.error(`> accounts: ADMIN_USERNAME "${admin.username}" belongs to an existing ${existing.role} account; it was NOT promoted. Choose another username.`);
  }
}
