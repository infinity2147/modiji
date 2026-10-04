/**
 * README screenshots (on demand only: `playwright test --grep @readme`). Writes the curated images the
 * README shows into docs/readme/, against the same hermetic production server as the other specs
 * (LLM_CALLS=off, no voice credentials). Everything is seeded through the public APIs and the real UI.
 *
 * The screen frames the expert's rules cite are real CaseDesk screenshots with the customer's names,
 * registration number and address blurred, standing in for what the browser's on-device OCR redaction
 * uploads while the expert shares their screen (headless Chromium cannot share a screen).
 */
import { mkdirSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { type APIRequestContext, type Browser, type Page } from "@playwright/test";
import { ASHA, LENA, dismissCoach, expect, signInPage, test } from "./support/accounts";

const OUT = join(import.meta.dirname, "../../../docs/readme");
mkdirSync(OUT, { recursive: true });
const out = (name: string): string => join(OUT, name);

const STOP_QUOTE = "Never approve a customer on a high-risk country list at desk level.";
const QUOTE_ENHANCED = "A brand-new customer from a high-risk country always goes to enhanced review.";
const HIGH_NEW = { and: [{ "==": [{ var: "jurisdictionRisk" }, "high"] }, { "==": [{ var: "customerStatus" }, "new"] }] };

async function ok<T>(response: Awaited<ReturnType<APIRequestContext["post"]>>): Promise<T> {
  expect(response.ok(), `${response.url()} → ${response.status()} ${await response.text()}`).toBe(true);
  return (await response.json()) as T;
}

/** Lets short transitions settle before a picture. */
async function settle(page: Page, ms = 600): Promise<void> {
  await page.waitForTimeout(ms);
}

function queueItem(page: Page, caseId: string) {
  return page.getByRole("list", { name: "Cases" }).getByRole("button").filter({ hasText: caseId });
}

/** Blurs the customer's identifying values on the open case, as the on-device OCR redaction does; returns how many regions. */
async function blurPii(page: Page): Promise<number> {
  return page.evaluate(() => {
    const targets: Element[] = [];
    const title = document.getElementById("case-title");
    if (title) targets.push(title);
    for (const dt of document.querySelectorAll("dt")) {
      if (["Name", "Registration no.", "Address", "Relationship manager"].includes(dt.textContent?.trim() ?? "")) {
        if (dt.nextElementSibling) targets.push(dt.nextElementSibling);
      }
    }
    for (const table of document.querySelectorAll("table")) for (const row of table.querySelectorAll("tbody tr")) if (row.firstElementChild) targets.push(row.firstElementChild);
    for (const el of targets) (el as HTMLElement).style.filter = "blur(5px)";
    // The queue shows names too.
    for (const el of document.querySelectorAll('[aria-label="Cases"] button p, [aria-label="Cases"] button span')) {
      if (/[a-z]{3,}/.test(el.textContent ?? "") && !/Open|Decided|Company|Individual/.test(el.textContent ?? "")) (el as HTMLElement).style.filter = "blur(4px)";
    }
    return targets.length;
  });
}

/**
 * Real redacted frames: a throwaway expert session in a second browser page renders each case, the PII is
 * blurred, and the screenshot is uploaded to `sessionId` through the frames route.
 */
async function framesOf(browser: Browser, baseURL: string, caseIds: string[], who = ASHA): Promise<Map<string, { png: Buffer; regions: number }>> {
  const context = await browser.newContext({ baseURL, viewport: { width: 1440, height: 900 } });
  const page = await context.newPage();
  await signInPage(page, who);
  const { sessionId } = await ok<{ sessionId: string }>(await page.request.post("/api/sessions", { data: { mode: "expert", caseSet: "training" } }));
  await page.goto(`/sandbox?session=${sessionId}&set=training&mode=expert`);
  const frames = new Map<string, { png: Buffer; regions: number }>();
  for (const caseId of caseIds) {
    await queueItem(page, caseId).click();
    await expect(page.locator("#case-title")).toBeVisible();
    await settle(page, 500);
    const regions = await blurPii(page);
    frames.set(caseId, { png: await page.screenshot(), regions });
  }
  await context.close();
  return frames;
}

async function uploadRealFrame(request: APIRequestContext, sessionId: string, frameSeq: number, frame: { png: Buffer; regions: number }) {
  const metadata = {
    frameSeq,
    captureTime: Date.now(),
    privacyEpoch: 0,
    changeScore: 24,
    redactedRegions: frame.regions,
    source: { width: 1440, height: 900 },
    bbox: null,
    crop: null,
  };
  const response = await request.post(`/api/sessions/${sessionId}/frames`, {
    multipart: { metadata: JSON.stringify(metadata), frame: { name: "frame.png", mimeType: "image/png", buffer: frame.png } },
  });
  expect(response.status(), await response.text()).toBe(202);
  return (await response.json()) as { frameId: string; ledgerId: string };
}

/** An expert session with the training cases decided through the CaseDesk APIs, each with a real redacted frame. */
async function seedSession(request: APIRequestContext, frames: Map<string, { png: Buffer; regions: number }>, decisions: Record<string, string>): Promise<string> {
  const { sessionId } = await ok<{ sessionId: string }>(await request.post("/api/sessions", { data: { mode: "expert", caseSet: "training" } }));
  let frameSeq = 0;
  for (const [caseId, action] of Object.entries(decisions)) {
    frameSeq += 1;
    const event = { id: randomUUID(), frameSeq, captureTime: Date.now(), sessionEpoch: 0, kind: "open_case", caseId, confidence: 1, source: "dom", critical: false };
    await ok(await request.post(`/api/sessions/${sessionId}/events`, { data: { events: [event] } }));
    const frame = frames.get(caseId);
    if (frame) await uploadRealFrame(request, sessionId, frameSeq, frame);
    const { checkId } = await ok<{ checkId: string }>(await request.post("/api/interlock/check", { data: { sessionId, caseId, edits: {}, proposedAction: action } }));
    await ok(await request.post(`/api/sessions/${sessionId}/decisions`, { data: { caseId, edits: {}, action, checkId } }));
  }
  return sessionId;
}

/** Headless Chromium cannot capture a screen: a canvas stream stands in for what the picker returns (as in tutor.spec). */
async function installFakeScreen(page: Page) {
  await page.addInitScript(() => {
    const canvas = document.createElement("canvas");
    canvas.width = 1280;
    canvas.height = 720;
    const ctx = canvas.getContext("2d");
    let tick = 0;
    setInterval(() => {
      if (!ctx) return;
      ctx.fillStyle = tick++ % 2 === 0 ? "#ffffff" : "#fefefe";
      ctx.fillRect(0, 0, 1280, 720);
    }, 100);
    if (navigator.mediaDevices) navigator.mediaDevices.getDisplayMedia = async () => canvas.captureStream(10);
  });
}

test("@readme capture: CaseDesk with the interview tools and the gate HUD", async ({ page }) => {
  test.setTimeout(120_000);
  await installFakeScreen(page);
  await signInPage(page, ASHA);
  await page.goto("/sandbox");
  await page.getByRole("radio", { name: /^Expert capture/ }).click();
  await page.getByRole("radio", { name: /^Training/ }).click();
  await page.getByRole("button", { name: "Start session" }).click();
  await expect(page).toHaveURL(/\/sandbox\?session=/);
  await page.goto(`${page.url()}&diagnostics=1`);
  await page.getByText("Interview tools", { exact: true }).click();

  // One case decided (the engine queues its questions), the next one under review.
  await queueItem(page, "NS-2026-0101").click();
  await page.getByRole("combobox", { name: "Risk rating" }).click();
  await page.getByRole("option", { name: "High", exact: true }).click();
  await page.getByRole("radio", { name: "Send to enhanced review" }).click();
  await page.getByRole("button", { name: "Save decision" }).click();
  await expect(page.getByRole("status").filter({ hasText: "Decision committed" })).toBeVisible();

  await queueItem(page, "NS-2026-0102").click();
  await page.getByRole("combobox", { name: "Risk rating" }).click();
  await page.getByRole("option", { name: "Medium", exact: true }).click();
  await page.getByRole("radio", { name: "Request documents" }).click();

  const share = page.getByRole("button", { name: /Share screen/ });
  if (await share.isVisible().catch(() => false)) await share.click().catch(() => undefined);
  const voice = page.getByRole("region", { name: /^Voice · Interviewer agent/ });
  await voice.scrollIntoViewIfNeeded();
  await page.mouse.move(700, 400);
  await settle(page, 2500);
  await page.screenshot({ path: out("capture-casedesk.png") });

  await page.getByRole("button", { name: "Engineering view" }).click();
  const judge = page.locator("[data-gate-ignore]").filter({ has: page.getByRole("region", { name: /Speech gate/ }) });
  await expect(page.getByRole("region", { name: "Engineering view" })).toBeVisible();
  await settle(page, 2500);
  await judge.screenshot({ path: out("gate-hud.png") });
});

const DECISIONS: Record<string, string> = { "NS-2026-0101": "requestDocuments", "NS-2026-0102": "approve", "NS-2026-0103": "enhancedReview" };
const AGREED = ["when politically exposed person is yes, send to enhanced review", "when country risk is medium, request documents"];

function answerTo(question: string): string {
  if (question.includes("Here's a rule I think you follow:")) return AGREED.some((a) => question.includes(a)) ? "Yes" : "No";
  if (/Save (it|that as a rule|that change|that)\?$/.test(question)) return "Yes";
  if (question.includes("Did I get that right?")) return "Yes, that's right.";
  if (question.includes("Is there anything you would never allow") || question.includes("Any other hard stop")) return "No";
  if (question.includes("what would you decide?")) return "Yes";
  return "Skip";
}

test("@readme debrief and Work Map", async ({ page, request, browser, baseURL }) => {
  test.setTimeout(180_000);
  const frames = await framesOf(browser, baseURL ?? "", Object.keys(DECISIONS));
  const sessionId = await seedSession(request, frames, DECISIONS);
  // A hard stop in the expert's own words (the conversation reads free words only with the model, which is off here).
  await ok(
    await request.post(`/api/sessions/${sessionId}/debrief`, {
      data: {
        action: "confirm_stop_rule",
        decisionFamily: "reviewOutcome",
        when: { combinator: "all", conditions: [{ feature: "jurisdictionRisk", op: "==", value: "high" }] },
        effect: { type: "forbid", action: "approve" },
        quote: STOP_QUOTE,
      },
    }),
  );

  await page.goto(`/debrief/${sessionId}`);
  const transcript = page.getByTestId("debrief-transcript");
  const agent = transcript.getByTestId("turn-agent");
  await expect(agent.first()).toContainText("Let's go over what I learned");
  let shotMid = false;
  for (let i = 0; i < 40 && !(await page.getByTestId("debrief-done").isVisible()); i += 1) {
    const count = await agent.count();
    const reply = answerTo((await agent.last().textContent()) ?? "");
    const quick = page.getByRole("group", { name: "Quick replies" }).getByRole("button", { name: reply, exact: true });
    if (await quick.isVisible()) await quick.click();
    else {
      await page.getByLabel("Your answer").fill(reply);
      await page.getByLabel("Your answer").press("Enter");
    }
    await expect(agent).toHaveCount(count + 1);
    if (!shotMid && count >= 4) {
      shotMid = true;
      await page.evaluate(() => window.scrollTo(0, 0));
      await settle(page, 800);
      await page.screenshot({ path: out("debrief-conversation-start.png") });
    }
  }
  await expect(page.getByTestId("debrief-done")).toBeVisible();
  await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
  await settle(page, 1000);
  await page.screenshot({ path: out("debrief-conversation-end.png") });
  await page.evaluate(() => window.scrollTo(0, 0));
  await settle(page, 800);
  await page.screenshot({ path: out("debrief-conversation-done-top.png") });

  await page.getByRole("link", { name: "Work Map", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Work Map" })).toBeVisible();
  await expect(page.getByTestId("step").first()).toBeVisible();
  await settle(page, 1500);
  await page.screenshot({ path: out("workmap.png") });

  // The hard stop's trace: the redacted frame the expert was looking at, through to their exact words.
  await page.getByRole("button", { name: /^Trace step 2$/ }).click();
  const chain = page.getByTestId("lineage-chain");
  await expect(chain.locator('[data-stage="frame"]').first()).toBeVisible();
  await settle(page, 1500);
  await page.screenshot({ path: out("workmap-lineage.png") });
  await chain.evaluate((el) => {
    let node: HTMLElement | null = el as HTMLElement;
    while (node && node.scrollHeight <= node.clientHeight + 1) node = node.parentElement;
    if (node) node.scrollTop = node.scrollHeight;
  });
  await settle(page, 800);
  await page.screenshot({ path: out("workmap-lineage-end.png") });
  await page.keyboard.press("Escape");

  // The whole chain for one of the expert's words, frame first, on a taller page so it fits in one picture.
  await page.setViewportSize({ width: 1440, height: 1600 });
  await page.getByTestId("reason-quote").first().getByRole("button", { name: "Trace expert quote" }).click();
  await expect(page.getByTestId("lineage-chain").locator('[data-kind="expert.statement"]').first()).toBeVisible();
  await settle(page, 1500);
  await page.getByRole("dialog").screenshot({ path: out("workmap-quote-lineage.png") });
  await page.keyboard.press("Escape");
  await page.setViewportSize({ width: 1440, height: 900 });

  await page.getByTestId("step").first().getByRole("button", { name: /^Trace step 1$/ }).click();
  await expect(page.getByTestId("lineage-chain").locator('[data-stage="frame"]').first()).toBeVisible();
  await settle(page, 1500);
  await page.screenshot({ path: out("workmap-step-lineage.png") });
});

test("@readme tutor intervention before Save", async ({ page, request, browser, baseURL }) => {
  test.setTimeout(180_000);
  const frames = await framesOf(browser, baseURL ?? "", Object.keys(DECISIONS));
  // Approving NS-2026-0102 (high country risk) is now forbidden by the expert's stop-rule from the debrief test.
  const sessionId = await seedSession(request, frames, { ...DECISIONS, "NS-2026-0102": "enhancedReview" });
  type Proposal = { candidateId: string; decisionFamily: string; action: string; text: string };
  type Debrief = { proposals: Proposal[]; rules: { rule: { id: string; effect: { type: string; action?: string } } }[] };
  const debrief = await ok<Debrief>(await request.get(`/api/sessions/${sessionId}/debrief`));
  const proposal = debrief.proposals.find((p) => p.action === "enhancedReview");
  if (proposal) {
    const confirmed = await ok<{ state: Debrief }>(
      await request.post(`/api/sessions/${sessionId}/debrief`, {
        data: { action: "confirm_candidate", candidateId: proposal.candidateId, decisionFamily: proposal.decisionFamily, quote: `Yes — ${proposal.text}.` },
      }),
    );
    const rule = confirmed.state.rules.find((r) => r.rule.effect.type === "recommend" && r.rule.effect.action === "enhancedReview");
    if (rule) await ok(await request.post(`/api/sessions/${sessionId}/debrief`, { data: { action: "revise_rule", ruleId: rule.rule.id, predicate: HIGH_NEW, priority: 100, quote: QUOTE_ENHANCED } }));
  }

  await signInPage(page, LENA);
  await page.goto("/sandbox");
  await page.getByRole("radio", { name: /^Novice practice/ }).click();
  await page.getByRole("radio", { name: /^Held-out/ }).click();
  await page.getByRole("button", { name: "Start session" }).click();
  await expect(page).toHaveURL(/\/sandbox\?session=/);
  await dismissCoach(page);
  await queueItem(page, "NS-2026-0201").click();
  const prompt = page.getByRole("region", { name: "What would the expert decide?" });
  if (await prompt.isVisible()) {
    await prompt.getByRole("radio", { name: "Approve onboarding" }).click();
    await prompt.getByRole("button", { name: "Lock in prediction" }).click();
    await expect(page.getByTestId("reveal-card")).toBeVisible();
  }
  await page.getByRole("radio", { name: "Approve onboarding" }).click();
  const card = page.getByTestId("intervention-card");
  await expect(card).toBeVisible();
  // Scroll only the side panel (not the page) so the whole card shows under the top bar.
  await card.evaluate((el) => {
    let panel: HTMLElement | null = el.parentElement;
    while (panel && !(panel.scrollHeight > panel.clientHeight + 1 && /(auto|scroll)/.test(getComputedStyle(panel).overflowY))) panel = panel.parentElement;
    if (panel) panel.scrollTop += el.getBoundingClientRect().top - panel.getBoundingClientRect().top - 250;
    window.scrollTo(0, 0);
  });
  await page.mouse.move(700, 400);
  await settle(page, 1200);
  await page.screenshot({ path: out("tutor-intervention.png") });
});
