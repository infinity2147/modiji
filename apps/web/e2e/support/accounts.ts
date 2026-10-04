/**
 * Signed-in e2e: every spec acts through real accounts, the way people do. An account is signed up
 * through the public API (always a trainee) and, for an expert or an admin, granted the role by the
 * env admin (ADMIN_USERNAME) through the admin API — so the suite exercises the approval path too.
 *
 * `test` is Playwright's, with `request` and the browser `context` signed in (as `requestAs` /
 * `pageAs`, the expert Asha by default; null leaves one signed out). A spec that plays several people
 * switches with `signIn(context.request, who)` or opens another API context with `apiAs(who)`.
 */
import { expect, request as playwrightRequest, test as base, type APIRequestContext, type Page } from "@playwright/test";
import type { UserRole } from "@vashistha/core";
import { E2E_ADMIN } from "./operator";

export type Person = { username: string; displayName: string; role: UserRole };

export const ASHA: Person = { username: "asha-rao", displayName: "Asha Rao", role: "expert" };
export const PRIYA: Person = { username: "priya-sharma", displayName: "Priya Sharma", role: "expert" };
export const LENA: Person = { username: "lena-trainee", displayName: "Lena", role: "trainee" };
export const ADMIN: Person = { username: E2E_ADMIN.username, displayName: "Administrator", role: "admin" };

/** Every e2e account but the env admin shares this password. */
const PASSWORD = "e2e-password-not-a-secret";

function baseURL(): string {
  const url = base.info().project.use.baseURL;
  if (url === undefined) throw new Error("baseURL not set");
  return url;
}

async function expectOk(response: Awaited<ReturnType<APIRequestContext["post"]>>): Promise<unknown> {
  expect(response.ok(), `${response.url()} → ${response.status()} ${await response.text()}`).toBe(true);
  return response.json();
}

/** The env admin grants `role` to `username`. */
async function grant(username: string, role: UserRole): Promise<void> {
  const admin = await playwrightRequest.newContext({ baseURL: baseURL() });
  try {
    await expectOk(await admin.post("/api/auth/login", { data: E2E_ADMIN }));
    const { users } = (await expectOk(await admin.get("/api/admin/users"))) as { users: { id: string; username: string; role: UserRole }[] };
    const user = users.find((u) => u.username === username);
    if (user === undefined) throw new Error(`no account ${username}`);
    if (user.role !== role) await expectOk(await admin.post(`/api/admin/users/${user.id}`, { data: { action: "set_role", role } }));
  } finally {
    await admin.dispose();
  }
}

/** Signs `context` in as `who`, signing them up (and granting their role) the first time. */
export async function signIn(context: APIRequestContext, who: Person): Promise<void> {
  if (who.role === "admin" && who.username === E2E_ADMIN.username) {
    await expectOk(await context.post("/api/auth/login", { data: E2E_ADMIN }));
    return;
  }
  if ((await context.post("/api/auth/login", { data: { username: who.username, password: PASSWORD } })).ok()) return;
  await expectOk(
    await context.post("/api/auth/signup", { data: { username: who.username, displayName: who.displayName, password: PASSWORD, requestExpert: who.role === "expert" } }),
  );
  // The role applies on the next request: the sign-in the sign-up just made stays valid.
  if (who.role !== "trainee") await grant(who.username, who.role);
}

/** Signs the page's browser context in as `who` (its cookies are the page's). */
export function signInPage(page: Page, who: Person): Promise<void> {
  return signIn(page.context().request, who);
}

/** A separate API context signed in as `who`; dispose of it when done. */
export async function apiAs(who: Person): Promise<APIRequestContext> {
  const context = await playwrightRequest.newContext({ baseURL: baseURL() });
  await signIn(context, who);
  return context;
}

export const test = base.extend<{ requestAs: Person | null; pageAs: Person | null }>({
  requestAs: [ASHA, { option: true }],
  pageAs: [ASHA, { option: true }],
  request: async ({ request, requestAs }, use) => {
    if (requestAs !== null) await signIn(request, requestAs);
    await use(request);
  },
  context: async ({ context, pageAs }, use) => {
    if (pageAs !== null) await signIn(context.request, pageAs);
    await use(context);
  },
});

export { expect };

/**
 * A trainee's session with a coach that has rules to teach opens with the coach pop-up. Most tests are about
 * something else, so they decline it ("Not now"); the coach's own test (tutor.spec) goes through it.
 */
export async function dismissCoach(page: Page): Promise<void> {
  const skip = page.getByTestId("coach-skip");
  // The pop-up appears once the coach's rules have loaded; with no rules to teach it never appears.
  const shown = await skip.waitFor({ state: "visible", timeout: 4000 }).then(() => true, () => false);
  if (shown) await skip.click();
  await expect(page.getByTestId("coach-dialog")).toHaveCount(0);
}
