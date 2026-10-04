import { z } from "zod";
import { ExpertIdSchema } from "./expert";
import { IdSchema } from "./primitives";

/**
 * Who may do what. Anyone may sign up, as a trainee; only an admin grants the expert role, because an
 * expert's words become rules every human and agent is checked against. An admin manages accounts and
 * reads every session but never confirms a rule: nobody can put words in an expert's mouth.
 */
export const USER_ROLES = ["trainee", "expert", "admin"] as const;
export const UserRoleSchema = z.enum(USER_ROLES);
export type UserRole = z.infer<typeof UserRoleSchema>;

/**
 * A username is a slug, and an expert's username IS their expert id: sessions of one account share
 * one rulebook. Usernames never change, so the id in every ledger entry stays the account's.
 */
export const UsernameSchema = ExpertIdSchema.min(3, "at least 3 characters");

/** The signed-in account that started a session, recorded in `session.started` (sessions from before accounts carry none). */
export const SessionOwnerSchema = z.strictObject({
  userId: IdSchema,
  username: UsernameSchema,
  /** The account's role when the session started. */
  role: UserRoleSchema,
});
export type SessionOwner = z.infer<typeof SessionOwnerSchema>;
