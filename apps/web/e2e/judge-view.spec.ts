/**
 * P3 judge view and off-record control, end to end against the production server. Voice is NOT
 * configured there (no agent ids), so the voice panel must show its not-configured state while the
 * gate HUD, event ticker, compliance strip and off-record control keep working.
 */
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { expect, test, type APIRequestContext, type Page } from "@playwright/test";

const EVIDENCE_DIR = join(import.meta.dirname, "../../../docs/evidence/p3");
mkdirSync(EVIDENCE_DIR, { recursive: true });
const evidence = (name: string): string => join(EVIDENCE_DIR, name);

type Entry = { id: string; sequence: number; source: string; kind: string; privacyEpoch: number; payload: Record<string, unknown> };

const CAPTURE_SOURCES = new Set(["client", "vision", "dom", "voice"]);

async function startSession(page: Page, mode: "Expert capture" | "Novice practice", set: "Training" | "Practice"): Promise<string> {
  await page.goto("/sandbox");
  await page.getByRole("radio", { name: new RegExp(`^${mode}`) }).click();
  await page.getByRole("radio", { name: new RegExp(`^${set}`) }).click();
  await page.getByRole("button", { name: "Start session" }).click();
  await expect(page).toHaveURL(/\/sandbox\?session=/);
  await expect(queueItems(page).first()).toBeVisible();
  return new URL(page.url()).searchParams.get("session") ?? "";
}

const startExpertSession = (page: Page) => startSession(page, "Expert capture", "Training");

function queueItems(page: Page) {
  return page.getByRole("list", { name: "Cases" }).getByRole("button");
}

async function ledger(request: APIRequestContext, sessionId: string): Promise<Entry[]> {
  const response = await request.get(`/api/sessions/${sessionId}/ledger?limit=500`);
  expect(response.ok()).toBe(true);
  return ((await response.json()) as { entries: Entry[] }).entries;
}

const judgeView = (page: Page) => page.locator("[data-gate-ignore]").filter({ has: page.getByRole("region", { name: /Speech gate/ }) });

test("judge view: gate HUD reacts to typing, ticker follows the ledger, strip stays honestly pending, voice not configured", async ({
  page,
}) => {
  await startExpertSession(page);
  const hud = page.getByRole("region", { name: "Speech gate" });
  await expect(hud.getByRole("status", { name: "Gate status: LISTENING" })).toBeVisible();
  const conditions = hud.getByRole("list", { name: "Gate conditions" });
  for (const label of ["Typing", "Speaking", "Screen moving"]) await expect(conditions).toContainText(label);
  await expect(hud).toContainText("Reason: no question queued");

  // Keystrokes in the case area put the Typing condition on wait; 1.5 s of quiet clears it.
  await queueItems(page).first().focus();
  await page.keyboard.press("Shift");
  await expect(conditions.getByRole("listitem", { name: /^Typing: wait/ })).toBeVisible();
  await expect(conditions.getByRole("listitem", { name: "Typing: clear" })).toBeVisible({ timeout: 4000 });

  // Opening a case moves the screen: Screen moving waits, then clears.
  await queueItems(page).first().click();
  await expect(conditions.getByRole("listitem", { name: /^Screen moving: wait/ })).toBeVisible();
  await expect(conditions.getByRole("listitem", { name: "Screen moving: clear" })).toBeVisible({ timeout: 4000 });
  await expect(conditions.getByRole("listitem", { name: "Typing: clear" })).toBeVisible();
  await expect(conditions.getByRole("listitem", { name: "Speaking: clear" })).toBeVisible();
  await page.waitForTimeout(300);
  await judgeView(page).screenshot({ path: evidence("hud.png") });

  // The ticker renders the ledger: open_case, field_change (with domain labels), decision.
  const caseId = /NS-\d{4}-\d{4}/.exec((await queueItems(page).first().textContent()) ?? "")?.[0] ?? "";
  await page.getByRole("combobox", { name: "Risk rating" }).click();
  await page.getByRole("option", { name: "High", exact: true }).click();
  await page.getByRole("radio", { name: "Send to enhanced review" }).click();
  await page.getByRole("button", { name: "Save decision" }).click();
  await expect(page.getByRole("status").filter({ hasText: "Decision committed" })).toBeVisible();
  const ticker = page.getByRole("log", { name: "Ledger events" });
  await expect(ticker).toContainText(`Opened case · ${caseId}`);
  await expect(ticker).toContainText(`Analyst risk rating changed: Unrated→High · ${caseId}`);
  await expect(ticker).toContainText(`Interlock check · Send to enhanced review · ${caseId} → Allow`);
  await expect(ticker).toContainText(`Decision saved: Send to enhanced review · ${caseId}`);
  await expect(ticker.locator('[data-source="dom"]').first()).toBeVisible();

  // Compliance strip: nothing has been earned in a plain capture session, and it says so.
  const strip = page.getByRole("list", { name: "Compliance" });
  await expect(strip.getByRole("listitem", { name: "Live questions: 0/3, pending" })).toBeVisible();
  await expect(strip.getByRole("listitem", { name: "Guardrail: ✗, pending" })).toBeVisible();
  await expect(strip.getByRole("listitem", { name: "Debrief gaps closed: 0/3, pending" })).toBeVisible();
  await expect(strip.getByRole("listitem", { name: "Teach-back: ✗, pending" })).toBeVisible();
  await expect(strip.getByRole("listitem", { name: "Unseen case intercepted: ✗, pending" })).toBeVisible();
  await page.waitForTimeout(700);
  await judgeView(page).screenshot({ path: evidence("ticker.png") });

  // An expert interview needs an active screen share (a confirmed rule needs a frame of the quote's moment).
  const voice = page.getByRole("region", { name: /^Voice · Interviewer agent/ });
  await expect(voice.getByRole("button", { name: "Start interview" })).toBeDisabled();
  await expect(voice.getByText("Share your screen to start the interview")).toBeVisible();

  // Engineering view: all eight conditions, the (empty) queue and the engine state.
  await page.getByRole("button", { name: "Engineering view" }).click();
  const engineering = page.getByRole("region", { name: "Engineering view" });
  await expect(engineering.getByRole("region", { name: "Gate conditions (all 8)" }).locator("tbody tr")).toHaveCount(8);
  await expect(engineering.getByRole("region", { name: "Question queue" })).toContainText(/ontext v\d+ · 0 asked/);
  await expect(engineering.getByRole("region", { name: "Engine state" })).toContainText(/confirmed rule\(s\) · rulebook rev \d+/);
  await expect(engineering).toContainText("Keep this tab in the foreground");
  await expect(engineering).toContainText("No authorizations yet.");
  await page.waitForTimeout(700);
  await judgeView(page).screenshot({ path: evidence("engineering-view.png") });
});

test("tutor voice on a server without voice credentials: a clear not-configured state, CaseDesk keeps working", async ({ page }) => {
  await startSession(page, "Novice practice", "Practice");
  const voice = page.getByRole("region", { name: /^Voice · Tutor agent/ });
  await voice.getByRole("button", { name: "Connect voice" }).click();
  await expect(voice.getByText("Voice not configured on this server")).toBeVisible();
  await expect(voice.getByRole("status", { name: "Voice status" })).toHaveText("Not configured");
  await expect(voice).toContainText("ELEVENLABS_TUTOR_AGENT_ID");
  await expect(voice).toContainText("No turns yet.");
  await queueItems(page).first().click();
  await expect(page.getByRole("log", { name: "Ledger events" })).toContainText("Opened case");
  await expect(page.getByRole("region", { name: "Speech gate" }).getByRole("status", { name: "Gate status: LISTENING" })).toBeVisible();
});

test("off the record: red banner, capture paused, nothing recorded, resume with a new epoch", async ({ page, request }) => {
  const sessionId = await startExpertSession(page);
  const [first, second, third] = [0, 1, 2].map((i) => queueItems(page).nth(i));
  await first?.click();
  await expect(page.getByText("All DOM events delivered")).toBeVisible();

  await page.getByRole("button", { name: "Go off the record" }).click();
  const banner = page.getByRole("alert", { name: "Off the record" });
  await expect(banner).toBeVisible();
  await expect(banner).toContainText(
    "Off-record content is prevented from entering our evidence store; microphone and frame transmission are disabled while off the record. The trigger phrase itself may reach the voice provider.",
  );
  await expect(banner).not.toContainText("confirming with the server");
  await expect(page.getByText("DOM event capture paused — off the record")).toBeVisible();
  await expect(page.getByRole("region", { name: "Speech gate" })).toContainText("off the record: the agent stays silent");
  await expect(page.getByRole("region", { name: /^Voice/ }).getByRole("button", { name: "Start interview" })).toBeDisabled();

  // Work continues locally while off the record; none of it is captured.
  await second?.click();
  await expect(page.getByRole("combobox", { name: "Risk rating" })).toBeDisabled();
  const ticker = page.getByRole("log", { name: "Ledger events" });
  await expect(ticker).toContainText("Off the record — capture stopped");
  await page.waitForTimeout(400);
  await page.screenshot({ path: evidence("off-record.png") });

  // Resume with the keyboard shortcut.
  await page.keyboard.press("Alt+Shift+O");
  await expect(banner).toBeHidden();
  await expect(ticker).toContainText("Back on the record — new privacy epoch");
  await third?.click();
  await expect(page.getByText("All DOM events delivered")).toBeVisible();
  await expect(page.getByText("Event capture stopped")).toHaveCount(0);

  const thirdId = /NS-\d{4}-\d{4}/.exec((await third?.textContent()) ?? "")?.[0];
  const secondId = /NS-\d{4}-\d{4}/.exec((await second?.textContent()) ?? "")?.[0];
  await expect
    .poll(async () => (await ledger(request, sessionId)).some((e) => e.kind === "screen.event" && e.payload.caseId === thirdId))
    .toBe(true);
  const entries = await ledger(request, sessionId);
  const off = entries.find((e) => e.kind === "privacy.off_record");
  const on = entries.find((e) => e.kind === "privacy.on_record");
  expect(off?.source).toBe("system_control");
  expect(on?.source).toBe("system_control");
  if (!off || !on) throw new Error("privacy transitions missing from the ledger");
  expect(on.privacyEpoch).toBeGreaterThan(off.privacyEpoch);

  // Nothing captured while off the record; the case opened then never reached the ledger.
  const during = entries.filter((e) => e.sequence > off.sequence && e.sequence < on.sequence);
  expect(during.filter((e) => CAPTURE_SOURCES.has(e.source))).toEqual([]);
  expect(entries.some((e) => e.kind === "screen.event" && e.payload.caseId === secondId)).toBe(false);

  // Events after resuming carry the new epoch, in the payload and on the entry.
  const after = entries.filter((e) => e.sequence > on.sequence && e.kind === "screen.event");
  expect(after.length).toBeGreaterThan(0);
  for (const event of after) {
    expect(event.privacyEpoch).toBe(on.privacyEpoch);
    expect(event.payload.sessionEpoch).toBe(on.privacyEpoch);
  }
});

test("a session reloaded while off the record stays off the record", async ({ page, request }) => {
  const sessionId = await startExpertSession(page);
  await page.getByRole("button", { name: "Go off the record" }).click();
  await expect(page.getByRole("alert", { name: "Off the record" })).not.toContainText("confirming with the server");
  await page.reload();
  await expect(page.getByRole("alert", { name: "Off the record" })).toBeVisible();
  await expect(page.getByText("DOM event capture paused — off the record")).toBeVisible();
  await queueItems(page).first().click();
  await page.getByRole("alert", { name: "Off the record" }).getByRole("button", { name: "Resume the record" }).click();
  await expect(page.getByRole("alert", { name: "Off the record" })).toBeHidden();
  await queueItems(page).nth(1).click();
  await expect(page.getByText("All DOM events delivered")).toBeVisible();
  const entries = await ledger(request, sessionId);
  expect(entries.filter((e) => e.kind === "screen.event" && e.payload.kind === "open_case")).toHaveLength(1);
});
