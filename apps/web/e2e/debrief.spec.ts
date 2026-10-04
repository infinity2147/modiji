/**
 * P5 end to end against the production server: an expert session seeded through the public APIs
 * (CaseDesk decisions with a redacted screen frame uploaded through the frames route for each case),
 * then the debrief as ONE conversation: the engine asks (proposed rules, open cases, hard stops, the
 * teach-back) and the expert answers in the reply box; rules are confirmed by their replies, read back
 * where needed. Then the Work Map page with its frames and lineage trace. Every confirmation cites a real
 * `frame.received`; a session whose screen was never shared is refused (409 `no_screen_frame`).
 * Screenshots go to docs/evidence/p5/. The server runs with LLM_CALLS=off, so only yes / no / skip
 * replies are read, and prose is the labelled template.
 */
import { mkdirSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { type APIRequestContext } from "@playwright/test";
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

/** The proposals this expert agrees with; every other proposed rule is answered "No". */
const AGREED = ["when politically exposed person is yes, send to enhanced review", "when country risk is medium, request documents"];

/** What the expert answers to each kind of question. The server runs without a model: only yes / no / skip are read. */
function answerTo(question: string): string {
  if (question.includes("Here's a rule I think you follow:")) return AGREED.some((a) => question.includes(a)) ? "Yes" : "No";
  if (/Save (it|that as a rule|that change|that)\?$/.test(question)) return "Yes";
  if (question.includes("Did I get that right?")) return "Yes, that's right.";
  if (question.includes("Is there anything you would never allow") || question.includes("Any other hard stop")) return "No";
  if (question.includes("what would you decide?")) return "Yes";
  return "Skip";
}

test("debrief: one conversation — proposals confirmed by a yes, open cases answered, no hard stop, teach-back confirmed; Work Map with lineage", async ({ page, request }) => {
  const sessionId = await seedSession(request);

  await page.goto(`/debrief/${sessionId}`);
  await expect(page.getByRole("heading", { name: "Debrief" })).toBeVisible();
  const transcript = page.getByTestId("debrief-transcript");
  const agent = transcript.getByTestId("turn-agent");
  await expect(agent.first()).toContainText("Let's go over what I learned");
  // No old forms on the page: one conversation, one reply box.
  await expect(page.getByLabel("Your words (recorded as evidence)")).toHaveCount(0);
  await expect(page.getByText("The language model is off, so I understand yes, no and skip only.")).toBeVisible();
  // Voice: a Talk toggle beside Send (off until pressed), the microphone disclosure and the off-record switch.
  const talk = page.getByRole("button", { name: "Talk", exact: true });
  const voiceStatus = page.getByRole("status", { name: "Voice status" });
  await expect(talk).toBeVisible();
  await expect(talk).toHaveAttribute("aria-pressed", "false");
  await expect(voiceStatus).toHaveText("Voice off");
  await expect(page.getByText("Microphone is on only while Talk is on.")).toBeVisible();
  await expect(page.getByRole("button", { name: /Go off the record/ })).toBeEnabled();
  await page.screenshot({ path: evidence("debrief-conversation-start.png"), fullPage: true });
  // No voice credentials on this server: Talk says so plainly, and typing carries on.
  await talk.click();
  await expect(voiceStatus).toHaveText("Voice not set up");
  await expect(page.getByText(/Voice isn't set up on this server/)).toBeVisible();
  await expect(page.getByLabel("Your answer")).toBeEnabled();

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
  }
  await expect(page.getByTestId("debrief-done")).toBeVisible();
  await expect(agent.last()).toContainText("That's everything I needed.");

  // What the conversation produced: rules confirmed by the expert's replies, the teach-back confirmed, nothing typed into forms.
  await expect(page.getByTestId("rule")).not.toHaveCount(0);
  await expect(transcript.getByTestId("turn-outcome").filter({ hasText: "saved with your words" }).first()).toBeVisible();
  const state = await ok<{ rules: unknown[]; teachBack: { confirmedEntryId: string | null } | null }>(await request.get(`/api/sessions/${sessionId}/debrief`));
  expect(state.rules.length).toBeGreaterThanOrEqual(2);
  expect(state.teachBack?.confirmedEntryId).not.toBeNull();
  await page.waitForTimeout(800);
  await page.screenshot({ path: evidence("debrief-conversation-done.png"), fullPage: true });

  // Reloading resumes the same conversation (it is in the ledger), and a new rule can still be said after the closing.
  await page.reload();
  await expect(agent.last()).toContainText("That's everything I needed.");
  await expect(page.getByLabel("Your answer")).toBeEnabled();

  // Work Map: steps built by code, quotes with a disabled clip, rule graph, exports, lineage.
  await page.getByRole("link", { name: "Work Map", exact: true }).click();
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
