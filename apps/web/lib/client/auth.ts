/** Typed client for accounts (`lib/contracts/auth.ts`). */
import type { z } from "zod";
import {
  AdminUsersResponseSchema,
  ViewerResponseSchema,
  type AdminActionRequest,
  type AdminUsersResponse,
  type LoginRequestSchema,
  type SignupRequestSchema,
  type Viewer,
} from "../contracts/auth";
import { postJson as post, requestJson, type FetchFn } from "./api";

export async function signIn(fetchFn: FetchFn, body: z.input<typeof LoginRequestSchema>): Promise<Viewer> {
  return (await requestJson(fetchFn, "/api/auth/login", ViewerResponseSchema, post(body))).viewer;
}

export async function signUp(fetchFn: FetchFn, body: z.input<typeof SignupRequestSchema>): Promise<Viewer> {
  return (await requestJson(fetchFn, "/api/auth/signup", ViewerResponseSchema, post(body))).viewer;
}

export async function signOut(fetchFn: FetchFn): Promise<void> {
  await fetchFn("/api/auth/logout", { method: "POST" });
}

export function listAccounts(fetchFn: FetchFn): Promise<AdminUsersResponse> {
  return requestJson(fetchFn, "/api/admin/users", AdminUsersResponseSchema);
}

export function accountAction(fetchFn: FetchFn, userId: string, body: AdminActionRequest): Promise<AdminUsersResponse> {
  return requestJson(fetchFn, `/api/admin/users/${encodeURIComponent(userId)}`, AdminUsersResponseSchema, post(body));
}

/** A same-site path to return to after signing in; anything else (another origin, `//host`) becomes /home. */
export function safeNext(next: string | null | undefined): string {
  return next !== null && next !== undefined && next.startsWith("/") && !next.startsWith("//") && !next.startsWith("/\\") ? next : "/home";
}
