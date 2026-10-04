/**
 * P5 end to end against the production server: an expert session seeded through the public APIs
 * (CaseDesk decisions with a redacted screen frame uploaded through the frames route for each case,
 * then two proposed rules confirmed with the expert's typed words), then the debrief page — solver
 * witnesses, typed answers, teach-back, a deliberate correction that revises a rule, coverage closed —
 * and the Work Map page with its frames and lineage trace. Every confirmation cites a real
 * `frame.received`; a session whose screen was never shared is refused (409 `no_screen_frame`).
 * Screenshots go to docs/evidence/p5/. The server runs with LLM_CALLS=off, so prose is the labelled
 * template.
 */
import { mkdirSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { type APIRequestContext, type Locator, type Page } from "@playwright/test";
import { expect, test } from "./support/accounts";
import { uploadFrame } from "./support/screen-frame";

const EVIDENCE_DIR = join(import.meta.dirname, "../../../docs/evidence/p5");
mkdirSync(EVIDENCE_DIR, { recursive: true });
const evidence = (name: string): string => join(EVIDENCE_DIR, name);

const DECISIONS: Record<string, string> = { "NS-2026-0101": "requestDocuments", "NS-2026-0102": "approve", "NS-2026-0103": "enhancedReview" };

async function ok<T>(response: Awaited<ReturnType<APIRequestContext["post"]>>): Promise<T> {
  expect(response.ok(), `${response.url()} → ${response.status()} ${await response.text()}`).toBe(true);
  return (await response.json()) as T;
}

/** An expert session with the three training cases decided through the CaseDesk APIs (with screen frames unless `screen: false`). */
async function seedSession(request: APIRequestContext, { screen = true }: { screen?: boolean } = {}): Promise<string> {
  const { sessionId } = await ok<{ sessionId: string }>(await request.post("/api/sessions", { data: { mode: "expert", caseSet: "training" } }));
  let frameSeq = 0;
  for (const [caseId, action] of Object.entries(DECISIONS)) {
    frameSeq += 1;
    const event = { id: randomUUID(), frameSeq, captureTime: Date.now(), sessionEpoch: 0, kind: "open_case", caseId, confidence: 1, source: "dom", critical: false };
    await ok(await request.post(`/api/sessions/${sessionId}/events`, { data: { events: [event] } }));
    if (screen) await uploadFrame(request, sessionId, frameSeq);
    const { checkId } = await ok<{ checkId: string }>(await request.post("/api/interlock/check", { data: { sessionId, caseId, edits: {}, proposedAction: action } }));
    await ok(await request.post(`/api/sessions/${sessionId}/decisions`, { data: { caseId, edits: {}, action, checkId } }));
  }
  return sessionId;
}

type Proposal = { candidateId: string; decisionFamily: string; action: string; text: string };

/** The expert confirms two proposed rules in their own words (the debrief's explicit UI action, via its API). */
async function confirmProposals(request: APIRequestContext, sessionId: string): Promise<void> {
  const state = await ok<{ proposals: Proposal[] }>(await request.get(`/api/sessions/${sessionId}/debrief`));
  const pick = (text: string, action: string): Proposal => {
    const p = state.proposals.find((x) => x.text === text && x.action === action);
    if (p === undefined) throw new Error(`no proposal "${text}" → ${action}: ${JSON.stringify(state.proposals.map((x) => [x.text, x.action]))}`);
    return p;
  };
  const confirm = async (p: Proposal, quote: string): Promise<void> => {
    await ok(await request.post(`/api/sessions/${sessionId}/debrief`, { data: { action: "confirm_candidate", candidateId: p.candidateId, decisionFamily: p.decisionFamily, quote } }));
  };
  await confirm(pick("politically exposed person is yes", "enhancedReview"), "Any politically exposed person goes to enhanced review.");
  await confirm(pick("country risk is medium", "requestDocuments"), "In a medium-risk country we ask for documents.");
}

function witness(page: Page, kind: string): Locator {
  return page.getByTestId("witness").and(page.locator(`[data-kind="${kind}"]`));
}

async function answer(card: Locator, quote: string, submit: string): Promise<void> {
  const form = card.locator("form").filter({ has: card.page().getByRole("button", { name: submit }) });
  await form.getByLabel("Your words (recorded as evidence)").fill(quote);
  await form.getByRole("button", { name: submit }).click();
}

test("debrief: witnesses → typed answers → teach-back correction → coverage closed; Work Map with lineage", async ({ page, request }) => {
  test.setTimeout(180_000);
  const sessionId = await seedSession(request);
  await confirmProposals(request, sessionId);

  await page.goto(`/debrief/${sessionId}`);
  await expect(page.getByRole("heading", { name: "Debrief" })).toBeVisible();
  const coverage = page.getByTestId("coverage-panel");
  await expect(coverage.getByText("Coverage under current model")).toBeVisible();
  await expect(coverage).toHaveAttribute("data-closed", "false");
  await expect(page.getByTestId("coverage-closed")).toHaveCount(0);

  // The solver ran on load: one unresolved cell and one genuine conflict, each with a queued debrief question.
  const unresolved = witness(page, "unresolved").and(page.locator('[data-status="queued"]'));
  const conflict = witness(page, "conflict").and(page.locator('[data-status="queued"]'));
  await expect(unresolved).toHaveCount(1);
  await expect(conflict).toHaveCount(1);
  // The question was queued when the PEP rule was the only one confirmed (a witness keeps its id, hence its question,
  // while its assignment is unchanged), so it names the PEP condition; the card's chips are the live decision cell.
  await expect(unresolved.getByTestId("witness-question")).toContainText("Politically exposed person: no — what would you decide?");
  await expect(unresolved.getByText("country risk not medium", { exact: true })).toBeVisible();
  await expect(unresolved.getByText("politically exposed person: no", { exact: true })).toBeVisible();
  await page.screenshot({ path: evidence("debrief-witnesses.png"), fullPage: true });

  // Typed answers (no voice): a rule for the unresolved cell, and which rule wins the conflict.
  await unresolved.getByLabel("Decision").selectOption("approve");
  await answer(unresolved, "Not a medium-risk country and no PEP — that's a straight approval.", "Add rule for these cases");
  await expect(witness(page, "unresolved").first()).toHaveAttribute("data-status", "resolved");
  await conflict.getByLabel("Request documents").check();
  await answer(conflict, "Documents first — the PEP review comes after we have the paperwork.", "This one applies");
  await expect(page.getByTestId("rule-diff").filter({ hasText: "rule revised" })).toBeVisible();

  // Teach-back from confirmed rules only (template: this server has no model key).
  await page.getByRole("button", { name: "Write teach-back" }).click();
  const teachBack = page.getByTestId("teachback");
  await expect(teachBack.getByText("template (LLM unavailable)")).toBeVisible({ timeout: 60_000 });
  await expect(teachBack.getByTestId("teachback-text")).toContainText("Did I get that right?");
  await page.screenshot({ path: evidence("debrief-teachback.png"), fullPage: true });

  // The deliberate correction: documents only when the owner holds more than 25%.
  const docsRule = page.getByTestId("rule").filter({ hasText: "request documents" }).first();
  await docsRule.getByRole("button", { name: "Correct this rule" }).click();
  await docsRule.getByLabel("Condition feature").selectOption({ label: "Largest beneficial owner share" });
  await docsRule.getByLabel("Condition operator").selectOption(">");
  await docsRule.getByLabel("Condition value").fill("25");
  const revisionBefore = await page.getByTestId("rulebook-revision").textContent();
  await answer(docsRule, "Not quite — only when the owner holds more than a quarter.", "Correct teach-back");
  await expect(page.getByTestId("rulebook-revision")).not.toHaveText(revisionBefore ?? "");
  const diff = page.getByTestId("rule-diff").filter({ hasText: "predicate" });
  await expect(diff).toBeVisible();
  await expect(diff).toContainText("above 25%");
  await page.waitForTimeout(900);
  await page.screenshot({ path: evidence("debrief-correction-diff.png"), fullPage: true });

  // The solver reran on the revised rule: the new small-owner cell is escalated; the threshold is confirmed.
  const newGap = witness(page, "unresolved").and(page.locator('[data-status="queued"]'));
  await expect(newGap).toHaveCount(1);
  await expect(newGap.getByText("largest beneficial owner share at most 25%", { exact: true })).toBeVisible();
  await expect(newGap.getByText("country risk medium", { exact: true })).toBeVisible();
  await answer(newGap, "Small owners in a medium-risk country aren't mine to decide — escalate to the controller.", "Escalate to controller");
  await expect(page.locator('[data-testid="witness"][data-status="acknowledged"]')).toHaveCount(1);
  const threshold = witness(page, "boundary").and(page.locator('[data-status="queued"]')).first();
  await expect(threshold.getByTestId("witness-question")).toContainText("Largest beneficial owner share exactly 25%");
  await answer(threshold, "Exactly 25% is fine — only above a quarter.", "Rule is right at the threshold");

  // A new teach-back was written for the revised rulebook; the expert confirms it.
  await expect(teachBack.getByRole("button", { name: "Confirm teach-back" })).toBeVisible();
  await answer(teachBack, "Yes, that's right.", "Confirm teach-back");
  await expect(coverage).toHaveAttribute("data-closed", "true");
  await expect(page.getByTestId("coverage-closed")).toHaveText("No unresolved counterexample exists under the current feature model.");
  await expect(coverage.locator('[data-ok="true"]')).toHaveCount(4);
  await page.waitForTimeout(800);
  await page.screenshot({ path: evidence("debrief-coverage-closed.png"), fullPage: true });

  // Work Map: steps built by code, quotes with a disabled clip, rule graph, exports, lineage.
  await page.getByRole("link", { name: "Work Map" }).click();
  await expect(page.getByRole("heading", { name: "Work Map" })).toBeVisible();
  await expect(page.getByTestId("step")).toHaveCount(3);
  await expect(page.getByRole("img", { name: "Redacted frame of NS-2026-0101" })).toBeVisible();
  const clip = page.getByRole("button", { name: /Play clip: audio clip requires a voice session/ }).first();
  await expect(clip).toBeDisabled();
  await expect(page.getByTestId("rule-graph")).toBeVisible();
  await expect(page.getByTestId("mcp-info")).toContainText("check_action");
  await page.screenshot({ path: evidence("workmap.png"), fullPage: true });

  const download = page.waitForEvent("download");
  await page.getByRole("link", { name: "Work Map JSON" }).click();
  expect((await download).suggestedFilename()).toMatch(/^workmap-wm_[0-9a-f]+\.json$/);

  await page.getByTestId("step").first().getByRole("button", { name: /^Trace step 1$/ }).click();
  const chain = page.getByTestId("lineage-chain");
  await expect(chain.locator('[data-stage="screen_event"]')).toBeVisible();
  await expect(chain.locator('[data-stage="frame"]').first()).toBeVisible();
  await expect(chain.locator('[data-stage="decision"]')).toBeVisible();
  await expect(chain.locator('[data-stage="confirmed_rule"]')).toBeVisible();
  await page.waitForTimeout(1_500);
  await page.screenshot({ path: evidence("workmap-lineage.png") });
  await page.keyboard.press("Escape");

  await page.getByTestId("reason-quote").first().getByRole("button", { name: "Trace expert quote" }).click();
  await expect(chain.locator('[data-kind="expert.statement"]').first()).toBeVisible();
  await page.waitForTimeout(1_200);
  await page.screenshot({ path: evidence("workmap-quote-lineage.png") });
});

test("debrief: a session whose screen was never shared cannot confirm a rule (409 no_screen_frame)", async ({ request }) => {
  const sessionId = await seedSession(request, { screen: false });
  const state = await ok<{ proposals: Proposal[]; screenFrames: number }>(await request.get(`/api/sessions/${sessionId}/debrief`));
  expect(state.screenFrames).toBe(0);
  const p = state.proposals[0];
  if (p === undefined) throw new Error("no proposal");
  const confirm = await request.post(`/api/sessions/${sessionId}/debrief`, {
    data: { action: "confirm_candidate", candidateId: p.candidateId, decisionFamily: p.decisionFamily, quote: "Yes, that is how I decide it." },
  });
  expect(confirm.status()).toBe(409);
  expect(await confirm.json()).toMatchObject({ error: "no_screen_frame" });
  const stop = await request.post(`/api/sessions/${sessionId}/debrief`, {
    data: {
      action: "confirm_stop_rule",
      decisionFamily: "reviewOutcome",
      when: { combinator: "all", conditions: [{ feature: "jurisdictionRisk", op: "==", value: "high" }] },
      effect: { type: "forbid", action: "approve" },
      quote: "Never approve a customer on a high-risk country list at desk level.",
    },
  });
  expect(stop.status()).toBe(409);
  expect(await stop.json()).toMatchObject({ error: "no_screen_frame" });
});
