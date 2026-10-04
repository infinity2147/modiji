/**
 * CaseDesk end to end, against the production server. The P1 rulebook is empty, so the real
 * interlock always allows; the forbid / approval paths are exercised by intercepting the check
 * response in the browser (`page.route`), never by test hooks in the app.
 */
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { type APIRequestContext, type Page, type Route } from "@playwright/test";

// Pages sign in as whoever the session needs (startSession); ledger reads go through the admin, who reads every session.
test.use({ requestAs: ADMIN });
import { ADMIN, ASHA, LENA, dismissCoach, expect, signInPage, test } from "./support/accounts";

/** The training set: three core demo cases (NS-2026-0101..0103), then five judgment cases (0104..0108). */
const TRAINING_CASES = 8;

const EVIDENCE_DIR = join(import.meta.dirname, "../../../docs/evidence/p1");
mkdirSync(EVIDENCE_DIR, { recursive: true });
const evidence = (name: string): string => join(EVIDENCE_DIR, name);

type Entry = {
  id: string;
  sequence: number;
  source: string;
  kind: string;
  parentIds: string[];
  payload: Record<string, unknown>;
};

/** A realistic confirmed-guardrail result: rule ids and an expert quote as the P5 rulebook will carry them. */
const EXPERT_QUOTE = {
  kind: "expert_quote",
  utteranceId: "utt-7f3c2a",
  exactQuote:
    "If we can't verify who actually owns the company, it doesn't get approved. I don't care how long they've banked with us.",
  t0Ms: 64_200,
  t1Ms: 71_900,
  frameIds: ["frame-0418"],
  eventIds: ["evt-0419"],
  relation: "supports",
  provenance: "human_voice",
} as const;

async function startSession(page: Page, mode: "Expert capture" | "Novice practice", set: "Training" | "Held-out" | "Practice") {
  await signInPage(page, mode === "Expert capture" ? ASHA : LENA);
  await page.goto("/sandbox");
  await expect(page.getByRole("heading", { name: "Start a review session" })).toBeVisible();
  await page.getByRole("radio", { name: new RegExp(`^${mode}`) }).click();
  await page.getByRole("radio", { name: new RegExp(`^${set}`) }).click();
  await page.getByRole("button", { name: "Start session" }).click();
  await expect(page).toHaveURL(/\/sandbox\?session=[^&]+&set=\w+&mode=\w+$/);
  if (mode === "Novice practice") await dismissCoach(page);
  await expect(queueItems(page).first()).toBeVisible();
  return new URL(page.url()).searchParams.get("session") ?? "";
}

function queueItems(page: Page) {
  return page.getByRole("list", { name: "Cases" }).getByRole("button");
}

async function caseIdOf(page: Page, index: number): Promise<string> {
  const text = (await queueItems(page).nth(index).textContent()) ?? "";
  const match = /NS-\d{4}-\d{4}/.exec(text);
  if (!match) throw new Error(`no case id in queue item ${index}: ${text}`);
  return match[0];
}

async function review(page: Page, rating: string, outcome: string) {
  await page.getByRole("combobox", { name: "Risk rating" }).click();
  await page.getByRole("option", { name: rating, exact: true }).click();
  await expect(page.getByRole("combobox", { name: "Risk rating" })).toHaveText(rating);
  await page.getByRole("radio", { name: outcome }).click();
}

/** Lets the short framer-motion transitions (≤ 0.35 s) finish so evidence screenshots show the settled UI. */
async function settled(page: Page, name: string) {
  await page.waitForTimeout(400);
  await page.screenshot({ path: evidence(name) });
}

async function ledger(request: APIRequestContext, sessionId: string): Promise<Entry[]> {
  const response = await request.get(`/api/sessions/${sessionId}/ledger?limit=500`);
  expect(response.ok()).toBe(true);
  const body = (await response.json()) as { entries: Entry[] };
  return body.entries;
}

/** Replaces the interlock decision in the real check response, keeping the real (ledgered) checkId. */
function interceptCheck(page: Page, result: Record<string, unknown>, times = 1) {
  return page.route(
    "**/api/interlock/check",
    async (route: Route) => {
      const real = await route.fetch();
      const body = (await real.json()) as { checkId: string };
      await route.fulfill({ response: real, json: { checkId: body.checkId, result } });
    },
    { times },
  );
}

test("P1 acceptance: an expert processes the three training cases by hand", async ({ page, request }) => {
  const sessionId = await startSession(page, "Expert capture", "Training");
  await expect(page.getByLabel("Session")).toContainText("Expert capture");
  // The three core demo cases come first; the judgment cases follow them in the queue.
  await expect(queueItems(page)).toHaveCount(TRAINING_CASES);
  await settled(page, "queue-start.png");

  const plan = [
    { rating: "High", outcome: "Send to enhanced review" },
    { rating: "Low", outcome: "Approve onboarding" },
    { rating: "Medium", outcome: "Request documents" },
  ];
  const caseIds: string[] = [];
  for (const [index, step] of plan.entries()) {
    const caseId = await caseIdOf(page, index);
    caseIds.push(caseId);
    const item = queueItems(page).nth(index);
    await item.click();
    await expect(item).toHaveAttribute("aria-current", "true");
    await expect(page.getByRole("article")).toContainText(caseId);
    for (const section of ["Customer", "Relationship", "Business", "Beneficial owners", "Screening", "Source of funds", "Documents"])
      await expect(page.getByRole("region", { name: section, exact: true })).toBeVisible();

    await review(page, step.rating, step.outcome);
    if (index === 0) await settled(page, "review-form.png");
    await page.getByRole("button", { name: "Save decision" }).click();
    await expect(page.getByRole("status").filter({ hasText: "Decision committed" })).toBeVisible();
    await expect(item).toContainText("Decided");
    await expect(item).toContainText(`Outcome: ${step.outcome}`);
    await settled(page, `case-${index + 1}.png`);
  }
  await expect(page.getByRole("progressbar", { name: "Cases decided" })).toHaveAttribute("aria-valuenow", "3");
  await expect(page.getByText("All DOM events delivered")).toBeVisible();
  await settled(page, "queue-finished.png");

  // The ledger holds the whole session, every entry labelled with its source.
  await expect
    .poll(async () => (await ledger(request, sessionId)).filter((e) => e.payload.kind === "action").length, {
      message: "three action events reach the ledger",
    })
    .toBe(3);
  const entries = await ledger(request, sessionId);

  expect(entries.filter((e) => e.kind === "session.started")).toHaveLength(1);
  const events = entries.filter((e) => e.kind === "screen.event");
  for (const event of events) {
    expect(event.source).toBe("dom");
    expect(event.payload.source).toBe("dom");
  }
  const seqs = events.map((e) => e.payload.frameSeq as number);
  expect(seqs[0]).toBe(1);
  for (let i = 1; i < seqs.length; i += 1) expect(seqs[i]).toBeGreaterThan(seqs[i - 1] ?? 0);
  const kinds = events.map((e) => e.payload.kind);
  for (const kind of ["navigate", "open_case", "field_change", "action"]) expect(kinds).toContain(kind);
  expect(events.filter((e) => e.payload.kind === "open_case").map((e) => e.payload.caseId)).toEqual(caseIds);
  const changes = events.filter((e) => e.payload.kind === "field_change");
  expect(changes.map((e) => [e.payload.caseId, e.payload.field, e.payload.to])).toEqual(
    caseIds.map((id, i) => [id, "riskRating", plan[i]?.rating.toLowerCase()]),
  );
  expect(changes.every((e) => e.payload.critical === true)).toBe(true);

  const checks = entries.filter((e) => e.kind === "interlock.check");
  const decisions = entries.filter((e) => e.kind === "case.decision");
  expect(checks).toHaveLength(3);
  expect(decisions).toHaveLength(3);
  for (const [i, decision] of decisions.entries()) {
    const check = checks.find((c) => c.id === decision.parentIds[0]);
    expect(check, `decision ${decision.id} cites its check`).toBeDefined();
    expect(decision.parentIds).toEqual([check?.id]);
    expect(decision.payload.caseId).toBe(caseIds[i]);
    expect(check?.payload.caseId).toBe(caseIds[i]);
    expect((decision.payload.result as { decision: string }).decision).toBe("allow");
  }
  const actions = events.filter((e) => e.payload.kind === "action");
  expect(actions.map((e) => e.payload.caseId)).toEqual(caseIds);
});

test("a forbid from the interlock blocks the commit and shows the expert's quote", async ({ page, request }) => {
  const sessionId = await startSession(page, "Novice practice", "Held-out");
  const commits: string[] = [];
  page.on("request", (r) => {
    if (r.url().includes("/decisions")) commits.push(r.url());
  });
  await interceptCheck(page, {
    decision: "forbid",
    matchedRules: ["rule-ubo-unverified-v2"],
    missingFeatures: [],
    evidence: [EXPERT_QUOTE],
  });

  const item = queueItems(page).first();
  await item.click();
  await review(page, "Low", "Approve onboarding");
  await page.getByRole("button", { name: "Save decision" }).click();

  const dialog = page.getByRole("dialog", { name: "Blocked by a confirmed guardrail" });
  await expect(dialog).toBeVisible();
  await expect(dialog.getByRole("blockquote")).toContainText(EXPERT_QUOTE.exactQuote);
  await expect(dialog).toContainText("1:04.2–1:11.9");
  await expect(dialog).toContainText("rule-ubo-unverified-v2");
  await expect(dialog.getByRole("button", { name: /commit/i })).toHaveCount(0);
  await expect(dialog.getByRole("textbox")).toHaveCount(0);
  await settled(page, "interlock-forbid.png");

  await dialog.getByRole("button", { name: "Return to case" }).click();
  await expect(dialog).toBeHidden();
  await expect(item).toContainText("Open");
  expect(commits).toEqual([]);
  const entries = await ledger(request, sessionId);
  expect(entries.filter((e) => e.kind === "case.decision")).toHaveLength(0);
});

test("needs_approval requires a note; acknowledging commits through the real server", async ({ page, request }) => {
  const sessionId = await startSession(page, "Novice practice", "Practice");
  await interceptCheck(page, {
    decision: "needs_approval",
    matchedRules: ["rule-pep-approval-v1"],
    missingFeatures: [],
    evidence: [{ ...EXPERT_QUOTE, exactQuote: "Anything with a PEP on it, I want a second pair of eyes before it goes out." }],
  });

  const item = queueItems(page).first();
  await item.click();
  await review(page, "High", "Approve onboarding");
  await page.getByRole("button", { name: "Save decision" }).click();

  const dialog = page.getByRole("dialog", { name: "Approval required" });
  await expect(dialog).toBeVisible();
  const acknowledge = dialog.getByRole("button", { name: "Acknowledge and commit" });
  await expect(acknowledge).toBeDisabled();
  await expect(dialog.getByRole("button", { name: "Escalate" })).toBeDisabled();
  await dialog.getByLabel("Note (required)").fill("Second review done with the team lead; PEP exposure documented.");
  await expect(acknowledge).toBeEnabled();
  await settled(page, "interlock-needs-approval.png");

  await acknowledge.click();
  await expect(dialog).toBeHidden();
  await expect(page.getByRole("status").filter({ hasText: "Decision committed" })).toBeVisible();
  await expect(item).toContainText("Decided");
  await expect(item).toContainText("Outcome: Approve onboarding");

  // The server re-ran the (empty) rulebook at commit time: allow, so no override is recorded.
  const decisions = (await ledger(request, sessionId)).filter((e) => e.kind === "case.decision");
  expect(decisions).toHaveLength(1);
  expect((decisions[0]?.payload.result as { decision: string }).decision).toBe("allow");
});

test("insufficient_information lists the missing features by their domain labels and can be escalated", async ({ page }) => {
  await startSession(page, "Novice practice", "Practice");
  await interceptCheck(page, {
    decision: "insufficient_information",
    matchedRules: ["rule-sof-required-v1"],
    missingFeatures: ["sourceOfFunds", "uboVerified"],
    evidence: [],
  });
  const item = queueItems(page).nth(1);
  await item.click();
  await review(page, "Medium", "Approve onboarding");
  await page.getByRole("button", { name: "Save decision" }).click();

  const dialog = page.getByRole("dialog", { name: "Insufficient information" });
  await expect(dialog).toBeVisible();
  await expect(dialog.getByRole("listitem").filter({ hasText: "Source of funds" })).toBeVisible();
  await expect(dialog.getByRole("listitem").filter({ hasText: "Largest owner identity verified" })).toBeVisible();
  await dialog.getByLabel("Note (required)").fill("Escalating: source of funds evidence is outstanding.");
  await dialog.getByRole("button", { name: "Escalate" }).click();
  await expect(dialog).toBeHidden();
  await expect(item).toContainText("Decided");
});

test("reloading the session URL resumes it with decided cases still marked", async ({ page, request }) => {
  const sessionId = await startSession(page, "Expert capture", "Training");
  const first = queueItems(page).first();
  await first.click();
  await review(page, "Medium", "Escalate to compliance officer");
  await page.getByRole("button", { name: "Save decision" }).click();
  await expect(first).toContainText("Decided");
  await expect(page.getByText("All DOM events delivered")).toBeVisible();

  const url = page.url();
  await page.reload();
  expect(page.url()).toBe(url);
  await expect(queueItems(page)).toHaveCount(TRAINING_CASES);
  await expect(queueItems(page).first()).toContainText("Outcome: Escalate to compliance officer");
  await expect(queueItems(page).nth(1)).toContainText("Open");
  await expect(page.getByRole("progressbar", { name: "Cases decided" })).toHaveAttribute("aria-valuenow", "1");

  // The resumed DOM channel continues the frame sequence: new events are accepted, not refused as stale.
  await queueItems(page).first().click();
  await expect(page.getByRole("status").filter({ hasText: "Decision committed" })).toBeVisible();
  await queueItems(page).nth(1).click();
  // The first open case is opened for the reviewer on load (also after a reload), so opens are counted from there.
  await expect
    .poll(async () => (await ledger(request, sessionId)).filter((e) => e.payload.kind === "open_case").length)
    .toBeGreaterThanOrEqual(3);
  await expect(page.getByText("All DOM events delivered")).toBeVisible();
  await expect(page.getByText("Event capture stopped")).toHaveCount(0);
  await settled(page, "resume-after-reload.png");

  const events = (await ledger(request, sessionId)).filter((e) => e.kind === "screen.event");
  expect(events.filter((e) => e.payload.kind === "navigate").length).toBeGreaterThanOrEqual(2);
  const seqs = events.map((e) => e.payload.frameSeq as number);
  expect([...seqs].sort((a, b) => a - b)).toEqual(seqs);
  expect(new Set(seqs).size).toBe(seqs.length);
});
