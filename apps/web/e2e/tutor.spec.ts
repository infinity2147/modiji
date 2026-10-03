/**
 * P6 tutor end to end against the production server (voice not configured: placeholder keys).
 *
 * The expert's rulebook is seeded through public APIs only: an expert CaseDesk session decides the
 * training cases, then the debrief's explicit expert actions confirm two proposed rules and revise
 * them in the expert's typed words (`confirm_candidate`, `revise_rule`). The novice then works the
 * held-out set: predict → reveal on NS-2026-0201, commit, mastery, practice cases.
 *
 * Stop-rules: no public API (debrief action or interview path) confirms a rule with a `forbid`
 * effect yet, so the spoken intervention and the interlock block on a confirmed stop-rule are proven
 * by the server-handler scripted run (test/server/tutor-monitor.test.ts, ledger ordering) and the
 * interlock property test; the second test below shows the intervention card's UI states with
 * route-intercepted tutor responses (labelled as such, as P1 did for interlock dialogs).
 * Screenshots go to docs/evidence/p6/.
 */
import { mkdirSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { expect, test, type APIRequestContext, type Page } from "@playwright/test";

const EVIDENCE_DIR = join(import.meta.dirname, "../../../docs/evidence/p6");
mkdirSync(EVIDENCE_DIR, { recursive: true });
const evidence = (name: string): string => join(EVIDENCE_DIR, name);

const HIGH_NEW = { and: [{ "==": [{ var: "jurisdictionRisk" }, "high"] }, { "==": [{ var: "customerStatus" }, "new"] }] };
const DOCS = { and: [{ ">": [{ var: "uboOwnershipPct" }, 25] }, { "==": [{ var: "uboVerified" }, false] }] };
const QUOTE_ENHANCED = "A brand-new customer from a high-risk country always goes to enhanced review.";
const QUOTE_DOCS = "If the biggest owner holds more than 25% and we haven't verified them, ask for documents.";
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

async function startNovice(page: Page): Promise<string> {
  await page.goto("/sandbox");
  await page.getByRole("radio", { name: /^Novice practice/ }).click();
  await page.getByRole("radio", { name: /^Held-out/ }).click();
  await page.getByRole("button", { name: "Start session" }).click();
  await expect(page).toHaveURL(/\/sandbox\?session=[^&]+&set=heldout&mode=novice$/);
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
  await expect(replay).toContainText("Frame unavailable");
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

  const entries = await ledger(request, sessionId);
  const kinds = entries.map((e) => e.kind);
  expect(kinds).toEqual(expect.arrayContaining(["tutor.prediction", "case.decision", "mastery.updated"]));
  const prediction = entries.find((e) => e.kind === "tutor.prediction");
  expect(prediction?.payload).toMatchObject({ caseId: "NS-2026-0201", predicted: "approve", expected: "enhancedReview", correct: false });
  const mastery = entries.find((e) => e.kind === "mastery.updated");
  expect(mastery?.payload).toMatchObject({ from: "untested", to: "assisted" });
  expect(mastery?.parentIds[0]).toBe(entries.find((e) => e.kind === "case.decision")?.id);

  // Unseen practice cases at the boundary of the weakest rules appear in the queue and can be decided.
  await page.getByRole("button", { name: "Generate practice cases" }).click();
  const practiceStatus = page.getByRole("region", { name: "Unseen practice cases" }).getByRole("status");
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
  const generated = (await ledger(request, sessionId)).filter((e) => e.kind === "case.generated");
  expect(generated.length).toBeGreaterThanOrEqual(1);
  expect(generated[0]?.payload).toMatchObject({ origin: { kind: "boundary_practice" } });
});

test("tutor: intervention card appears on selection, before Save (UI states; stop-rule responses route-intercepted)", async ({ page }) => {
  const sessionId = await startNovice(page);
  const QUOTE = "Never approve a new customer from a high-risk country on the spot.";
  const rule = {
    ruleId: "rule-never-approve",
    kind: "guardrail",
    when: "country risk is high and customer status is new",
    then: "never approve onboarding",
    stopRule: true,
    quote: {
      text: QUOTE,
      attribution: "The expert, by voice",
      replay: { frameUrl: null, frameNote: "Frame unavailable: no screen moment of this quote is on record.", screen: [], audioNote: "Audio playback unavailable: conversation audio is not stored, only the transcript quote." },
    },
    level: "untested",
  };
  const intervention = {
    entryId: "intercepted-intervention",
    caseId: "NS-2026-0201",
    trigger: "guardrail_violation",
    proposedAction: "approve",
    ruleIds: [rule.ruleId],
    questionId: "intercepted-question",
    text: `Careful — never approve onboarding when country risk is high and customer status is new. The expert said: "${QUOTE}"`,
    speech: "queued",
  };
  let intervened = false;
  await page.route(`**/api/sessions/${sessionId}/tutor`, async (route) => {
    const response = await route.fetch();
    const body = (await response.json()) as { rules: unknown[]; cases: { caseId: string; prompt: unknown; interventions: unknown[] }[] };
    body.rules = [...body.rules, rule];
    for (const c of body.cases)
      if (c.caseId === "NS-2026-0201") {
        c.prompt = { ask: false, reason: "Route-intercepted demo: decide directly." };
        if (intervened) c.interventions = [intervention];
      }
    await route.fulfill({ response, json: body });
  });
  await page.route(`**/api/sessions/${sessionId}/tutor/intent`, async (route) => {
    intervened = true;
    await route.fulfill({
      json: { result: { decision: "forbid", matchedRules: [rule.ruleId], missingFeatures: [], evidence: [] }, intervention, fresh: true },
    });
  });

  await queueItem(page, "NS-2026-0201").click();
  await page.getByRole("radio", { name: "Approve onboarding" }).click();
  const card = page.getByTestId("intervention-card");
  await expect(card).toBeVisible();
  await expect(card).toContainText("Careful — the expert's rule forbids “Approve onboarding” here");
  await expect(card.getByTestId("expert-quote")).toHaveText(`“${QUOTE}”`);
  await expect(card).toContainText("Queued for the tutor's voice");
  await expect(page.getByRole("button", { name: "Save decision" })).toBeEnabled();
  await shot(page, "intervention-card-before-save.png");
});
