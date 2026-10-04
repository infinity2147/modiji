/**
 * P6 tutor end to end against the production server (voice not configured: placeholder keys; LLM_CALLS=off).
 *
 * The expert's rulebook is seeded through public APIs only: an expert CaseDesk session decides the
 * training cases while a redacted screen frame of each case is uploaded through the frames route, then
 * the debrief's explicit expert actions confirm two proposed rules and revise them in the expert's
 * typed words (`confirm_candidate`, `revise_rule`). The novice then works the held-out set: predict →
 * reveal on NS-2026-0201, commit, mastery, practice cases.
 *
 * Stop-rule: the second test has an expert state a REAL stop-rule on the debrief page's "Add a
 * stop-rule" form (`confirm_stop_rule`, tied to a real frame); the novice's selection of the forbidden
 * outcome then makes the guardrail monitor intervene before Save, and Save is blocked by the interlock.
 * Nothing is route-intercepted. Screenshots go to docs/evidence/p6/.
 */
import { mkdirSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { type APIRequestContext, type Page } from "@playwright/test";
import { LENA, dismissCoach, expect, signInPage, test } from "./support/accounts";
import { uploadFrame } from "./support/screen-frame";

const EVIDENCE_DIR = join(import.meta.dirname, "../../../docs/evidence/p6");
mkdirSync(EVIDENCE_DIR, { recursive: true });
const evidence = (name: string): string => join(EVIDENCE_DIR, name);

const HIGH_NEW = { and: [{ "==": [{ var: "jurisdictionRisk" }, "high"] }, { "==": [{ var: "customerStatus" }, "new"] }] };
const DOCS = { and: [{ ">": [{ var: "uboOwnershipPct" }, 25] }, { "==": [{ var: "uboVerified" }, false] }] };
const QUOTE_ENHANCED = "A brand-new customer from a high-risk country always goes to enhanced review.";
const QUOTE_DOCS = "If the biggest owner holds more than 25% and we haven't verified them, ask for documents.";
const STOP_QUOTE = "Never approve a customer on a high-risk country list at desk level.";
/** Above the debrief's default priority, so these rules decide even beside other expert sessions' rules. */
const PRIORITY = 100;

type Entry = { id: string; sequence: number; source: string; kind: string; parentIds: string[]; payload: Record<string, unknown> };

async function ok<T>(response: Awaited<ReturnType<APIRequestContext["post"]>>): Promise<T> {
  expect(response.ok(), `${response.url()} → ${response.status()} ${await response.text()}`).toBe(true);
  return (await response.json()) as T;
}

/** The expert's rulebook, through the CaseDesk and debrief APIs (the expert's typed words are the evidence). */
async function seedExpertRulebook(request: APIRequestContext): Promise<void> {
  const { sessionId } = await ok<{ sessionId: string }>(await request.post("/api/sessions", { data: { mode: "expert", caseSet: "training" } }));
  const decisions: [string, string][] = [
    ["NS-2026-0101", "requestDocuments"],
    ["NS-2026-0102", "approve"],
    ["NS-2026-0103", "enhancedReview"],
  ];
  let frameSeq = 0;
  for (const [caseId, action] of decisions) {
    frameSeq += 1;
    const event = { id: randomUUID(), frameSeq, captureTime: Date.now(), sessionEpoch: 0, kind: "open_case", caseId, confidence: 1, source: "dom", critical: false };
    await ok(await request.post(`/api/sessions/${sessionId}/events`, { data: { events: [event] } }));
    await uploadFrame(request, sessionId, frameSeq);
    const { checkId } = await ok<{ checkId: string }>(await request.post("/api/interlock/check", { data: { sessionId, caseId, edits: {}, proposedAction: action } }));
    await ok(await request.post(`/api/sessions/${sessionId}/decisions`, { data: { caseId, edits: {}, action, checkId } }));
  }
  type Proposal = { candidateId: string; decisionFamily: string; action: string; text: string };
  type Debrief = { proposals: Proposal[]; rules: { rule: { id: string; effect: { type: string; action?: string } } }[] };
  const debrief = await ok<Debrief>(await request.get(`/api/sessions/${sessionId}/debrief`));
  const confirmAndRevise = async (action: string, predicate: unknown, quote: string): Promise<void> => {
    const proposal = debrief.proposals.find((p) => p.action === action);
    if (proposal === undefined) throw new Error(`no proposal for ${action}: ${JSON.stringify(debrief.proposals.map((p) => [p.text, p.action]))}`);
    const confirmed = await ok<{ state: Debrief }>(
      await request.post(`/api/sessions/${sessionId}/debrief`, {
        data: { action: "confirm_candidate", candidateId: proposal.candidateId, decisionFamily: proposal.decisionFamily, quote: `Yes — ${proposal.text}, ${action}.` },
      }),
    );
    const rule = confirmed.state.rules.find((r) => r.rule.effect.type === "recommend" && r.rule.effect.action === action);
    if (rule === undefined) throw new Error(`rule for ${action} not confirmed`);
    await ok(await request.post(`/api/sessions/${sessionId}/debrief`, { data: { action: "revise_rule", ruleId: rule.rule.id, predicate, priority: PRIORITY, quote } }));
  };
  await confirmAndRevise("enhancedReview", HIGH_NEW, QUOTE_ENHANCED);
  await confirmAndRevise("requestDocuments", DOCS, QUOTE_DOCS);
}

/** The trainee starts a held-out session in the browser; the API context stays the expert's. */
async function startNovice(page: Page): Promise<string> {
  await signInPage(page, LENA);
  await page.goto("/sandbox");
  await page.getByRole("radio", { name: /^Novice practice/ }).click();
  await page.getByRole("radio", { name: /^Held-out/ }).click();
  await page.getByRole("button", { name: "Start session" }).click();
  await expect(page).toHaveURL(/\/sandbox\?session=[^&]+&set=heldout&mode=novice$/);
  await dismissCoach(page);
  return new URL(page.url()).searchParams.get("session") ?? "";
}

function queueItem(page: Page, caseId: string) {
  return page.getByRole("list", { name: "Cases" }).getByRole("button").filter({ hasText: caseId });
}

async function ledger(request: APIRequestContext, sessionId: string): Promise<Entry[]> {
  return (await ok<{ entries: Entry[] }>(await request.get(`/api/sessions/${sessionId}/ledger?limit=500`))).entries;
}

async function shot(page: Page, name: string): Promise<void> {
  await page.waitForTimeout(400);
  await page.screenshot({ path: evidence(name) });
}

test("tutor: predict → reveal in the expert's words → commit → mastery → unseen practice case decided", async ({ page, request }) => {
  test.setTimeout(120_000);
  await seedExpertRulebook(request);
  const sessionId = await startNovice(page);

  // With rules to teach, the guide opens in "working": it numbers the three steps, and the first case is already open.
  const guide = page.getByTestId("trainee-guide");
  await expect(guide).toHaveAttribute("data-stage", "working");
  await expect(guide).toContainText("Predict what the expert would decide");
  await expect(page.getByRole("article")).toContainText("NS-2026-0201");

  // NS-2026-0201: new company, high-risk country. The review panel first asks for a prediction.
  await queueItem(page, "NS-2026-0201").click();
  const prompt = page.getByRole("region", { name: "What would the expert decide?" });
  await expect(prompt).toBeVisible();
  await expect(page.getByRole("button", { name: "Save decision" })).toHaveCount(0);
  await prompt.getByRole("radio", { name: "Approve onboarding" }).click();
  await shot(page, "predict-prompt.png");
  await prompt.getByRole("button", { name: "Lock in prediction" }).click();

  // Reveal: wrong, with the expert's rule, verbatim quote and the replay of their moment.
  const reveal = page.getByTestId("reveal-card");
  await expect(reveal).toContainText("Not quite — you predicted “Approve onboarding”; the expert would send to enhanced review.");
  await expect(reveal.getByTestId("expert-quote")).toHaveText(`“${QUOTE_ENHANCED}”`);
  await expect(reveal).toContainText("The expert, typed during the debrief");
  await shot(page, "reveal-wrong-prediction.png");
  await reveal.getByRole("button", { name: "Replay the expert’s moment" }).click();
  const replay = page.getByRole("dialog", { name: "The expert’s moment" });
  // The redacted frame the expert's words are tied to (uploaded through the frames route while they worked).
  await expect(replay.getByRole("img", { name: "Redacted frame of the expert's screen when they said this" })).toBeVisible();
  await expect(replay.getByRole("button", { name: "Play audio" })).toBeDisabled();
  await expect(replay).toContainText("No audio: the expert typed these words during the debrief.");
  await shot(page, "replay-moment.png");
  await page.keyboard.press("Escape");

  // Decide as the expert would; the interlock allows; the ladder moves to "assisted" (help was needed).
  await page.getByRole("radio", { name: "Send to enhanced review" }).click();
  await page.getByRole("button", { name: "Save decision" }).click();
  await expect(page.getByText("Decision committed")).toBeVisible();
  const enhancedRule = page.getByTestId("mastery-rule").filter({ hasText: "When country risk is high and customer status is new: send to enhanced review" });
  await expect(enhancedRule).toHaveAttribute("data-level", "assisted");
  await expect(page.getByRole("region", { name: "Mastery ladder" })).toContainText("heuristic estimate");
  await shot(page, "mastery-after-commit.png");

  const entries = await ledger(page.request, sessionId);
  const kinds = entries.map((e) => e.kind);
  expect(kinds).toEqual(expect.arrayContaining(["tutor.prediction", "case.decision", "mastery.updated"]));
  const prediction = entries.find((e) => e.kind === "tutor.prediction");
  expect(prediction?.payload).toMatchObject({ caseId: "NS-2026-0201", predicted: "approve", expected: "enhancedReview", correct: false });
  const mastery = entries.find((e) => e.kind === "mastery.updated");
  expect(mastery?.payload).toMatchObject({ from: "untested", to: "assisted" });
  expect(mastery?.parentIds[0]).toBe(entries.find((e) => e.kind === "case.decision")?.id);

  // More practice: cases at the boundary of the weakest rules appear in the queue and can be decided.
  await page.getByRole("button", { name: "Generate practice cases" }).click();
  const practiceStatus = page.getByRole("region", { name: "More practice" }).getByRole("status");
  await expect(practiceStatus).toContainText(/Added NS-2026-10\d\d/, { timeout: 30_000 });
  const added = /NS-2026-10\d\d/.exec((await practiceStatus.textContent()) ?? "")?.[0] ?? "";
  await expect(queueItem(page, added)).toBeVisible();
  await shot(page, "practice-cases-in-queue.png");
  await queueItem(page, added).click();
  const practicePrompt = page.getByRole("region", { name: "What would the expert decide?" });
  if (await practicePrompt.isVisible()) {
    await practicePrompt.getByRole("radio", { name: "Request documents" }).click();
    await practicePrompt.getByRole("button", { name: "Lock in prediction" }).click();
    await expect(page.getByTestId("reveal-card")).toBeVisible();
  }
  await page.getByRole("radio", { name: "Request documents" }).click();
  await page.getByRole("button", { name: "Save decision" }).click();
  await expect(page.getByText("Decision committed")).toBeVisible();
  await shot(page, "practice-case-decided.png");
  const generated = (await ledger(page.request, sessionId)).filter((e) => e.kind === "case.generated");
  expect(generated.length).toBeGreaterThanOrEqual(1);
  expect(generated[0]?.payload).toMatchObject({ origin: { kind: "boundary_practice" } });
});

/** An expert states a stop-rule on the debrief page ("Add a stop-rule"), tied to a real redacted frame of their capture. */
async function stateStopRule(page: Page, request: APIRequestContext): Promise<void> {
  const { sessionId } = await ok<{ sessionId: string }>(await request.post("/api/sessions", { data: { mode: "expert", caseSet: "training" } }));
  const caseId = "NS-2026-0103";
  const event = { id: randomUUID(), frameSeq: 1, captureTime: Date.now(), sessionEpoch: 0, kind: "open_case", caseId, confidence: 1, source: "dom", critical: false };
  await ok(await request.post(`/api/sessions/${sessionId}/events`, { data: { events: [event] } }));
  const frame = await uploadFrame(request, sessionId, 1);

  await page.goto(`/debrief/${sessionId}`);
  const form = page.getByTestId("stop-rule-form");
  await expect(form).toBeVisible();
  await form.getByLabel("Condition 1 feature").selectOption({ label: "Country risk (Northstar list)" });
  await form.getByLabel("Condition 1 value").selectOption("high");
  await form.getByRole("radio", { name: "Never allow" }).check();
  await form.getByLabel("Action").selectOption({ label: "Approve onboarding" });
  await form.getByLabel("Your words (recorded as evidence)").fill(STOP_QUOTE);
  await page.screenshot({ path: evidence("debrief-add-stop-rule.png"), fullPage: true });
  await form.getByRole("button", { name: "Confirm stop-rule" }).click();
  const rule = page.getByTestId("rule").filter({ hasText: "never approve onboarding" });
  await expect(rule).toBeVisible();
  await expect(rule).toContainText(`“${STOP_QUOTE}” (typed)`);
  await expect(rule.getByText("guardrail")).toBeVisible();

  // The confirmed rule cites the real frame (not a DOM event) and the exact words.
  const book = await ok<{ rules: { kind: string; effect: { type: string; action?: string }; evidence: { exactQuote?: string; frameIds?: string[] }[] }[] }>(await request.get("/api/rulebook"));
  const stop = book.rules.find((r) => r.evidence[0]?.exactQuote === STOP_QUOTE);
  expect(stop).toMatchObject({ kind: "guardrail", effect: { type: "forbid", action: "approve" } });
  expect(stop?.evidence[0]?.frameIds).toEqual([frame.ledgerId]);
}

test("tutor: a real stop-rule from the debrief → intervention on selection, before Save → Save blocked", async ({ page, request }) => {
  test.setTimeout(120_000);
  await stateStopRule(page, request);
  const sessionId = await startNovice(page);

  await queueItem(page, "NS-2026-0201").click();
  // Predict first when asked (the rule deciding this case is not mastered in this fresh session).
  const prompt = page.getByRole("region", { name: "What would the expert decide?" });
  if (await prompt.isVisible()) {
    await prompt.getByRole("radio", { name: "Send to enhanced review" }).click();
    await prompt.getByRole("button", { name: "Lock in prediction" }).click();
    await expect(page.getByTestId("reveal-card")).toBeVisible();
  }
  await page.getByRole("radio", { name: "Approve onboarding" }).click();
  const card = page.getByTestId("intervention-card");
  await expect(card).toBeVisible();
  await expect(card).toContainText("Careful — the expert's rule forbids “Approve onboarding” here");
  await expect(card.getByTestId("expert-quote")).toHaveText(`“${STOP_QUOTE}”`);
  await expect(card).toContainText("Queued for the tutor's voice");
  await expect(page.getByRole("button", { name: "Save decision" })).toBeEnabled();
  await shot(page, "intervention-card-before-save.png");

  // The intervention is ledgered before Save, citing the novice's selection; Save is then blocked by the interlock.
  const entries = await ledger(page.request, sessionId);
  const intent = entries.findLast((e) => e.kind === "tutor.intent");
  const intervention = entries.find((e) => e.kind === "tutor.intervention");
  expect(intervention?.payload).toMatchObject({ caseId: "NS-2026-0201", trigger: "guardrail_violation", proposedAction: "approve" });
  expect(intervention?.parentIds[0]).toBe(intent?.id);
  await page.getByRole("button", { name: "Save decision" }).click();
  await expect(page.getByRole("dialog")).toContainText("Blocked by a confirmed guardrail");
  await expect(page.getByRole("dialog")).toContainText(STOP_QUOTE);
  await shot(page, "interlock-blocked-by-stop-rule.png");
  const after = await ledger(page.request, sessionId);
  expect(after.some((e) => e.kind === "case.decision")).toBe(false);
  expect(Math.max(...after.filter((e) => e.kind === "tutor.intervention").map((e) => e.sequence))).toBeLessThan(
    Math.min(...after.filter((e) => e.kind === "interlock.check").map((e) => e.sequence)),
  );
});

// ── The coach pop-up: one step to a live coach ──

/** Headless Chromium cannot capture a screen (see perception.spec): a canvas stream stands in for what the picker returns. */
async function installFakeScreen(page: Page) {
  await page.addInitScript(() => {
    const canvas = document.createElement("canvas");
    canvas.width = 1280;
    canvas.height = 720;
    const ctx = canvas.getContext("2d");
    // Redrawn on a timer: a canvas that is never redrawn yields no video frame, and the share would wait for one forever.
    let tick = 0;
    setInterval(() => {
      if (!ctx) return;
      ctx.fillStyle = tick++ % 2 === 0 ? "#ffffff" : "#fefefe";
      ctx.fillRect(0, 0, 1280, 720);
    }, 100);
    if (navigator.mediaDevices) navigator.mediaDevices.getDisplayMedia = async () => canvas.captureStream(10);
  });
}

/** The coach needs rules to teach: seed them unless an earlier test in this file already did. */
async function ensureRules(request: APIRequestContext): Promise<void> {
  const book = await ok<{ rules: unknown[] }>(await request.get("/api/rulebook"));
  if (book.rules.length === 0) await seedExpertRulebook(request);
}

test("coach pop-up: taking a case asks for microphone and screen once; yes starts both; the coach still guides if voice is unavailable", async ({ page, request }) => {
  test.setTimeout(120_000);
  await ensureRules(request);
  await installFakeScreen(page);
  await signInPage(page, LENA);
  await page.goto("/sandbox");
  await page.getByRole("radio", { name: /^Novice practice/ }).click();
  await page.getByRole("radio", { name: /^Held-out/ }).click();
  await page.getByRole("button", { name: "Start session" }).click();

  // The first case is open and the coach asks, in one pop-up, for everything it needs.
  const dialog = page.getByTestId("coach-dialog");
  await expect(dialog).toBeVisible();
  await expect(dialog.getByRole("heading", { name: "Meet your coach" })).toBeVisible();
  await expect(dialog).toContainText("Microphone");
  await expect(dialog).toContainText("Screen");
  await expect(dialog).toContainText("off the record");
  await expect(dialog.getByTestId("coach-allow")).toBeVisible();
  await shot(page, "coach-popup.png");

  await dialog.getByTestId("coach-allow").click();
  // Screen: shared (the browser's picker is faked). Voice: this server has no voice credentials, and says so plainly.
  await expect(dialog.getByRole("heading", { name: /Starting your coach|Almost there/ })).toBeVisible();
  await expect(dialog.locator('li[data-state="ready"]')).toContainText("Shared with this session");
  await expect(dialog.locator('li[data-state="unavailable"]')).toContainText("Voice is not set up on this server");
  await shot(page, "coach-connecting.png");
  await dialog.getByTestId("coach-continue").click();
  await expect(dialog).toHaveCount(0);

  // The coach is never lost: the bar says where it is, and offers to turn voice on again.
  const bar = page.getByTestId("coach-bar");
  await expect(bar).toContainText("Coaching in text");
  await expect(bar.getByRole("button", { name: "Turn on voice coach" })).toBeVisible();
  await expect(page.getByTestId("trainee-guide")).toHaveAttribute("data-stage", "working");
  await shot(page, "coach-text-only.png");
});

test("coach pop-up: 'Not now' is respected, remembered across a reload, and reversible from the bar", async ({ page, request }) => {
  await ensureRules(request);
  const sessionId = await startNovice(page);
  const bar = page.getByTestId("coach-bar");
  await expect(bar).toContainText("Voice coach is off");
  await page.reload();
  await expect(page.getByTestId("coach-bar")).toContainText("Voice coach is off");
  await expect(page.getByTestId("coach-dialog")).toHaveCount(0);
  await bar.getByRole("button", { name: "Turn on voice coach" }).click();
  await expect(page.getByTestId("coach-dialog")).toBeVisible();
  expect(sessionId).not.toBe("");
});
