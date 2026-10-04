/**
 * HTTP contract for accounts: sign-up, sign-in, the signed-in viewer, and the admin's account list.
 * Browser-safe. Passwords travel only in sign-up and sign-in bodies and are never returned.
 */
import { z } from "zod";
import { IdSchema, UserRoleSchema, UsernameSchema } from "@vashistha/core";

export const PasswordSchema = z.string().min(10, "at least 10 characters").max(200);
export const DisplayNameSchema = z.string().trim().min(1).max(60);

/** POST /api/auth/signup — always a trainee; `requestExpert` puts the account in the admins' queue. */
export const SignupRequestSchema = z.strictObject({
  username: UsernameSchema,
  displayName: DisplayNameSchema,
  password: PasswordSchema,
  requestExpert: z.boolean().default(false),
});

/** POST /api/auth/login. The username is not validated as a slug, so a typo gets the same answer as a wrong password. */
export const LoginRequestSchema = z.strictObject({
  username: z.string().trim().toLowerCase().min(1).max(64),
  password: z.string().min(1).max(200),
});

export const ViewerSchema = z.strictObject({
  id: IdSchema,
  username: UsernameSchema,
  displayName: z.string(),
  role: UserRoleSchema,
  /** Asked for the expert role and not yet granted or declined. */
  expertRequested: z.boolean(),
});
export type Viewer = z.infer<typeof ViewerSchema>;

/** POST /api/auth/signup, POST /api/auth/login, GET /api/auth/me. */
export const ViewerResponseSchema = z.strictObject({ viewer: ViewerSchema });

export const AdminUserSchema = ViewerSchema.extend({
  createdAt: z.int(),
  disabled: z.boolean(),
  /**
   * Expert capture sessions already recorded under this username as an expert id. Above zero for an
   * account that never captured, they predate accounts: granting the expert role hands it that rulebook.
   */
  expertSessions: z.int().nonnegative(),
});
export type AdminUser = z.infer<typeof AdminUserSchema>;

export const ACCOUNT_EVENT_KINDS = ["signed_up", "bootstrapped", "role_changed", "expert_declined", "disabled", "enabled"] as const;

export const AccountEventSchema = z.strictObject({
  id: IdSchema,
  at: z.int(),
  /** The admin's username; null for a sign-up or the env bootstrap. */
  actor: z.string().nullable(),
  subject: z.string(),
  kind: z.enum(ACCOUNT_EVENT_KINDS),
  detail: z.record(z.string(), z.unknown()),
});
export type AccountEvent = z.infer<typeof AccountEventSchema>;

/** GET /api/admin/users — and every admin action returns the same. */
export const AdminUsersResponseSchema = z.strictObject({ users: z.array(AdminUserSchema), events: z.array(AccountEventSchema) });
export type AdminUsersResponse = z.infer<typeof AdminUsersResponseSchema>;

/** POST /api/admin/users/:userId */
export const AdminActionRequestSchema = z.discriminatedUnion("action", [
  z.strictObject({ action: z.literal("set_role"), role: UserRoleSchema }),
  z.strictObject({ action: z.literal("decline_expert") }),
  z.strictObject({ action: z.literal("set_disabled"), disabled: z.boolean() }),
]);
export type AdminActionRequest = z.infer<typeof AdminActionRequestSchema>;
