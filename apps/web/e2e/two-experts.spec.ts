/**
 * P10 two experts end to end against the production server (plan §7.10, §11 "disagreement witness
 * shown"). Two expert sessions are started through the public APIs with each expert's name (Priya
 * speaks Hindi), their CaseDesk decisions are captured with a redacted screen frame per case, and each
 * expert confirms their own rules in their own typed words through the debrief API:
 *   - Asha: high-risk country → enhanced review, and the long-standing customer exception → approve;
 *   - Priya: high-risk country → enhanced review, and a stop-rule in Hindi: never approve at desk level.
 * The "Two experts" page then asks Z3 for a valid case where the rulebooks disagree, shows it in domain
 * labels with each expert's decision, records both experts' typed answers, and shows the resolution diff
 * (a revision carrying both quotes) and the team rulebook. LLM_CALLS=off: no model is involved.
 * Screenshots go to docs/evidence/p10/.
 */
import { mkdirSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { expect, test, type APIRequestContext } from "@playwright/test";
import { uploadFrame } from "./support/screen-frame";

const EVIDENCE_DIR = join(import.meta.dirname, "../../../docs/evidence/p10");
mkdirSync(EVIDENCE_DIR, { recursive: true });
const evidence = (name: string): string => join(EVIDENCE_DIR, name);

// No "approve": the e2e server's team rulebook already holds other specs' stop-rules (one forbids approving high-risk cases).
const DECISIONS: Record<string, string> = { "NS-2026-0101": "requestDocuments", "NS-2026-0102": "enhancedReview", "NS-2026-0103": "enhancedReview" };
const HIGH = { "==": [{ var: "jurisdictionRisk" }, "high"] };
const LONG_STANDING_HIGH = { and: [{ "==": [{ var: "customerStatus" }, "existing"] }, { ">=": [{ var: "accountAgeMonths" }, 24] }, HIGH] };
const PRIYA_STOP_RULE = "अगर देश हाई-रिस्क लिस्ट पर है तो मैं डेस्क लेवल पर अप्रूव नहीं करती।";

type Rule = { rule: { id: string; effect: { type: string; action?: string } } };
type Debrief = { proposals: { candidateId: string; decisionFamily: string; action: string; text: string }[]; rules: Rule[]; witnesses: { witness: { id: string; kind: string }; current: boolean; status: string }[] };

async function ok<T>(response: Awaited<ReturnType<APIRequestContext["post"]>>): Promise<T> {
  expect(response.ok(), `${response.url()} → ${response.status()} ${await response.text()}`).toBe(true);
  return (await response.json()) as T;
}

/** An expert session named at start, with the three training cases decided and a screen frame per case. */
async function expertSession(request: APIRequestContext, expert: { name: string; language: "en" | "hi" }): Promise<string> {
  const { sessionId } = await ok<{ sessionId: string }>(await request.post("/api/sessions", { data: { mode: "expert", caseSet: "training", expert } }));
  let frameSeq = 0;
  for (const [caseId, action] of Object.entries(DECISIONS)) {
    frameSeq += 1;
    const event = { id: randomUUID(), frameSeq, captureTime: Date.now(), sessionEpoch: 0, kind: "open_case", caseId, confidence: 1, source: "dom", critical: false };
    await ok(await request.post(`/api/sessions/${sessionId}/events`, { data: { events: [event] } }));
    await uploadFrame(request, sessionId, frameSeq);
    const { checkId, result } = await ok<{ checkId: string; result: { decision: string } }>(
      await request.post("/api/interlock/check", { data: { sessionId, caseId, edits: {}, proposedAction: action } }),
    );
    // Sign-off rules confirmed by earlier specs may apply: the expert acknowledges them, as in CaseDesk.
    const override = result.decision === "allow" ? {} : { override: { kind: "acknowledged", note: "Reviewed the sign-off requirement." } };
    await ok(await request.post(`/api/sessions/${sessionId}/decisions`, { data: { caseId, edits: {}, action, checkId, ...override } }));
  }
  return sessionId;
}

async function debriefAction(request: APIRequestContext, sessionId: string, data: unknown): Promise<Debrief> {
  return (await ok<{ state: Debrief }>(await request.post(`/api/sessions/${sessionId}/debrief`, { data }))).state;
}

/** "High-risk country → enhanced review", confirmed from a proposal and corrected to the expert's own condition. */
async function highRiskRule(request: APIRequestContext, sessionId: string, quote: string): Promise<string> {
  const state = await ok<Debrief>(await request.get(`/api/sessions/${sessionId}/debrief`));
  const proposal = state.proposals.find((p) => p.action === "enhancedReview");
  if (proposal === undefined) throw new Error("an enhanced-review proposal was expected");
  const after = await debriefAction(request, sessionId, { action: "confirm_candidate", candidateId: proposal.candidateId, decisionFamily: proposal.decisionFamily, quote: "Those go to enhanced review." });
  const rule = after.rules.find((r) => r.rule.effect.action === "enhancedReview");
  if (rule === undefined) throw new Error("rule expected");
  await debriefAction(request, sessionId, { action: "revise_rule", ruleId: rule.rule.id, predicate: HIGH, quote });
  return rule.rule.id;
}

test("two experts: Z3 disagreement case → both answer → revision with both quotes → team rulebook", async ({ page, request }) => {
  test.setTimeout(240_000);
  const asha = await expertSession(request, { name: "Asha Rao", language: "en" });
  const priya = await expertSession(request, { name: "Priya Sharma", language: "hi" });

  // Asha: high risk → enhanced review; the long-standing exception → approve (a rule for an unresolved case, then corrected).
  const ashaEdd = await highRiskRule(request, asha, "Anything from a high-risk country goes to enhanced review.");
  const rebuilt = await ok<Debrief>(await request.post(`/api/sessions/${asha}/witnesses`));
  const open = rebuilt.witnesses.find((v) => v.current && v.witness.kind === "unresolved");
  if (open === undefined) throw new Error("an unresolved case was expected");
  const withException = await debriefAction(request, asha, { action: "add_rule_for_witness", witnessId: open.witness.id, decision: "approve", quote: "Those I approve." });
  const exception = withException.rules.find((r) => r.rule.effect.action === "approve");
  if (exception === undefined) throw new Error("approve rule expected");
  await debriefAction(request, asha, {
    action: "revise_rule",
    ruleId: exception.rule.id,
    predicate: LONG_STANDING_HIGH,
    priority: 30,
    overrides: [ashaEdd],
    quote: "Unless they have banked with us for two years or more; then I approve.",
  });

  // Priya: high risk → enhanced review; and her stop-rule, typed in Hindi.
  await highRiskRule(request, priya, "High-risk country means enhanced review, every time.");
  await debriefAction(request, priya, {
    action: "confirm_stop_rule",
    decisionFamily: "reviewOutcome",
    when: { combinator: "all", conditions: [{ feature: "jurisdictionRisk", op: "==", value: "high" }] },
    effect: { type: "forbid", action: "approve" },
    quote: PRIYA_STOP_RULE,
  });

  await page.goto("/experts?a=asha-rao&b=priya-sharma&family=reviewOutcome");
  await expect(page.getByRole("heading", { name: "Two experts" })).toBeVisible();
  await expect(page.getByRole("region", { name: "Both rulebooks" }).getByTestId("expert-rule")).toHaveCount(4);
  await expect(page.getByText("No disagreement recorded yet.")).toBeVisible();

  await page.getByRole("button", { name: "Find disagreements (Z3)" }).click();
  const card = page.getByTestId("disagreement");
  await expect(card).toHaveCount(1, { timeout: 60_000 });
  await expect(card).toHaveAttribute("data-status", "asked");
  await expect(card.getByRole("table", { name: "The case" })).toContainText("high");
  await expect(card.getByRole("table", { name: "The case" })).toContainText("existing");
  const answers = card.getByTestId("expert-answer");
  await expect(answers.nth(0)).toContainText("Their rulebook decides: Approve onboarding");
  await expect(answers.nth(1)).toContainText("Their rulebook decides: Send to enhanced review");
  // While they disagree: decision rules held back, Priya's Hindi stop-rule still in force.
  const team = page.getByRole("region", { name: "Team rulebook" });
  await expect(team.locator('[data-held="true"]')).toHaveCount(3);
  await expect(team.locator('[data-held="false"]').filter({ hasText: PRIYA_STOP_RULE })).toHaveCount(1);
  await page.screenshot({ path: evidence("two-experts-disagreement.png"), fullPage: true });

  for (const [i, quote] of [
    [0, "Fair point: even a long-standing customer from a high-risk country should get enhanced review."],
    [1, "Enhanced review. Two years of history does not change the country risk."],
  ] as const) {
    const block = answers.nth(i);
    await block.getByRole("combobox").selectOption("enhancedReview");
    await block.getByLabel("Your words (recorded as evidence)").fill(quote);
    await block.getByRole("button", { name: /^Record .*'s decision$/ }).click();
    await expect(block).toContainText(quote);
  }
  await expect(card).toHaveAttribute("data-status", "resolved", { timeout: 60_000 });
  const resolution = card.getByTestId("resolution");
  await expect(resolution).toContainText("revised to r3");
  await expect(resolution).toContainText("experts priya-sharma, asha-rao");
  await expect(team.locator('[data-held="true"]')).toHaveCount(0);
  await expect(page.getByText("0 open disagreements")).toBeVisible();
  await page.screenshot({ path: evidence("two-experts-resolved.png"), fullPage: true });

  // The solver reruns: no more disagreement between the two rulebooks.
  const again = await ok<{ written: string[] }>(await request.post("/api/disagreements", { data: { experts: ["asha-rao", "priya-sharma"], decisionFamily: "reviewOutcome" } }));
  expect(again.written).toEqual([]);
});
