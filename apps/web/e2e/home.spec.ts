/**
 * The signed-in shell and Home against the production server: each role sees its own sidebar and one
 * next step, what a role cannot do is shown locked with the reason, and the next-step button starts
 * the right kind of session. Anonymous visitors are sent to sign in and come back to where they were.
 */
import { ADMIN, ASHA, LENA, expect, signInPage, test } from "./support/accounts";

test.use({ pageAs: null, requestAs: null });

test("an anonymous visit to a signed-in page goes to sign-in and comes back after", async ({ page }) => {
  await page.goto("/admin");
  await expect(page).toHaveURL(/\/login\?next=%2Fadmin$/);
  await expect(page.getByRole("heading", { name: "Sign in" })).toBeVisible();
  await page.getByLabel("Username").fill("e2e-admin");
  await page.getByLabel("Password").fill("e2e-admin-password-not-a-secret");
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(page).toHaveURL(/\/admin$/);
  await expect(page.getByRole("heading", { name: "Accounts" })).toBeVisible();
});

test("a trainee sees one next step, locked expert tools with the reason, and starts a practice session", async ({ page }) => {
  await signInPage(page, LENA);
  await page.goto("/home");
  await expect(page.getByRole("heading", { name: /Welcome, Lena/ })).toBeVisible();
  const nav = page.getByRole("navigation", { name: "Main" });
  await expect(nav.getByRole("link", { name: "Practice" })).toBeVisible();
  await expect(nav.getByText("Needs the expert role")).toBeVisible();
  await expect(nav.getByRole("link", { name: "Accounts" })).toHaveCount(0);
  await expect(nav.getByLabel("Signed in as")).toContainText("Trainee");
  // No expert has confirmed a rule on this server: Home says so plainly, instead of inviting a practice that teaches nothing.
  await expect(page.getByTestId("coach-not-ready")).toContainText("Your coach has nothing to teach yet");
  await expect(page.getByRole("button", { name: "Start practising" })).toHaveCount(0);
  await page.screenshot({ path: "test-results/home-trainee.png", fullPage: true });
  await page.getByRole("button", { name: "Look around anyway" }).click();
  await expect(page).toHaveURL(/\/sandbox\?session=[^&]+&set=practice&mode=novice$/);

  // The trainee is guided: the first case is already open, the coach says what to do, and the expert instruments are not here.
  const guide = page.getByTestId("trainee-guide");
  await expect(guide).toHaveAttribute("data-stage", "no_rules");
  await expect(guide).toContainText("Your coach has nothing to teach yet");
  await expect(page.getByRole("heading", { level: 2, name: /^[A-Z]/ }).first()).toBeVisible();
  await expect(page.getByRole("article")).toBeVisible();
  await expect(page.getByRole("button", { name: "Share screen" })).toHaveCount(0);
  await expect(page.getByRole("region", { name: "Speech gate" })).toHaveCount(0);
  await expect(page.getByRole("list", { name: "Compliance" })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Enter a judge case" })).toHaveCount(0);
  // With nothing to teach there is nothing to switch on: no pop-up asking for microphone or screen, no voice bar.
  await expect(page.getByTestId("coach-dialog")).toHaveCount(0);
  await expect(page.getByTestId("coach-bar")).toHaveCount(0);
  await page.screenshot({ path: "test-results/trainee-workspace.png", fullPage: true });
});

test("an expert starts a capture session from Home and finds their sessions there", async ({ page }) => {
  await signInPage(page, ASHA);
  await page.goto("/home");
  const nav = page.getByRole("navigation", { name: "Main" });
  await expect(nav.getByRole("link", { name: "Capture" })).toBeVisible();
  await expect(nav.getByText("Locked")).toHaveCount(0);
  await expect(page.getByText("No sessions yet")).toBeVisible();
  await page.getByRole("button", { name: "Start a capture session" }).click();
  await expect(page).toHaveURL(/\/sandbox\?session=[^&]+&set=training&mode=expert$/);
  await page.goto("/home");
  const sessions = page.getByRole("region", { name: "Your sessions" });
  await expect(sessions.getByRole("link", { name: /Debrief/ })).toHaveCount(1);
  await expect(sessions.getByRole("link", { name: /Work Map/ })).toHaveCount(1);
  await page.screenshot({ path: "test-results/home-expert.png", fullPage: true });
});

test("an admin sees the account queue and cannot start a capture", async ({ page }) => {
  await signInPage(page, ADMIN);
  await page.goto("/home");
  await expect(page.getByRole("navigation", { name: "Main" }).getByRole("link", { name: "Accounts" })).toBeVisible();
  await expect(page.getByRole("link", { name: "Open accounts" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Start a capture session" })).toHaveCount(0);
});
