/**
 * Genuine local flows for the recordings, through the real UI and public APIs only (as the e2e specs do).
 *
 * Headless Chromium cannot share a screen, so where the browser's capture pipeline would upload a redacted
 * frame we upload a screenshot of the real CaseDesk page at that moment through the same frames route.
 * This is disclosed on screen. Expert answers are typed (the voice path needs the deployed service).
 */
import type { Browser } from "./playwright";
import { createSession, debrief, debriefAction, decide, uploadFrame } from "./seed";

export const TRAINING: [string, string][] = [
  ["NS-2026-0101", "requestDocuments"],
  ["NS-2026-0102", "approve"],
  ["NS-2026-0103", "enhancedReview"],
];

/** An expert session: each training case opened in the real CaseDesk (DOM events), its screen uploaded as a frame, then decided. */
export async function expertSessionWithScreens(browser: Browser, base: string, decisions = TRAINING): Promise<{ sessionId: string; frames: string[] }> {
  const sessionId = await createSession(base, "expert", "training");
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 }, timezoneId: "UTC" });
  const page = await ctx.newPage();
  const frames: string[] = [];
  try {
    await page.goto(`${base}/sandbox?session=${sessionId}&set=training&mode=expert`);
    let seq = 0;
    for (const [caseId, action] of decisions) {
      seq += 1;
      await page.getByRole("list", { name: "Cases" }).getByRole("button").filter({ hasText: caseId }).click();
      await page.waitForTimeout(900);
      const png = await page.screenshot();
      frames.push(await uploadFrame(base, sessionId, seq, png, 1440, 900));
      await decide(base, sessionId, caseId, action);
    }
  } finally {
    await ctx.close();
  }
  return { sessionId, frames };
}

/** The debrief e2e's starting point: two proposals confirmed in the expert's typed words. */
export async function confirmDebriefProposals(base: string, sessionId: string): Promise<void> {
  const state = await debrief(base, sessionId);
  const pick = (text: string, action: string) => {
    const p = state.proposals.find((x) => x.text === text && x.action === action);
    if (p === undefined) throw new Error(`no proposal "${text}" → ${action}: ${JSON.stringify(state.proposals.map((x) => [x.text, x.action]))}`);
    return p;
  };
  for (const [text, action, quote] of [
    ["politically exposed person is yes", "enhancedReview", "Any politically exposed person goes to enhanced review."],
    ["largest owner identity verified is no", "requestDocuments", "If we can't verify the owner, we ask for documents."],
  ] as const) {
    const p = pick(text, action);
    await debriefAction(base, sessionId, { action: "confirm_candidate", candidateId: p.candidateId, decisionFamily: p.decisionFamily, quote });
  }
}

export const HIGH_NEW = { and: [{ "==": [{ var: "jurisdictionRisk" }, "high"] }, { "==": [{ var: "customerStatus" }, "new"] }] };
export const DOCS = { and: [{ ">": [{ var: "uboOwnershipPct" }, 25] }, { "==": [{ var: "uboVerified" }, false] }] };
export const QUOTE_ENHANCED = "A brand-new customer from a high-risk country always goes to enhanced review.";
export const QUOTE_DOCS = "If the biggest owner holds more than 25% and we haven't verified them, ask for documents.";

/**
 * The tutor's rulebook (as apps/web/e2e/tutor.spec.ts seeds it), plus a stop-rule. The stop-rule's words are the
 * recorded live expert's sentence, RE-ENTERED BY TYPING in this local session — the deployed rulebook is not on a
 * local server — and its condition matches the live rule (country risk high ∧ relationship age < 24 months).
 */
export async function seedTutorRulebook(browser: Browser, base: string, stopQuote: string): Promise<string> {
  const { sessionId, frames } = await expertSessionWithScreens(browser, base);
  const state = await debrief(base, sessionId);
  for (const [action, predicate, quote] of [
    ["enhancedReview", HIGH_NEW, QUOTE_ENHANCED],
    ["requestDocuments", DOCS, QUOTE_DOCS],
  ] as const) {
    const proposal = state.proposals.find((p) => p.action === action);
    if (proposal === undefined) throw new Error(`no proposal for ${action}`);
    const confirmed = await debriefAction(base, sessionId, { action: "confirm_candidate", candidateId: proposal.candidateId, decisionFamily: proposal.decisionFamily, quote: `Yes — ${proposal.text}, ${action}.` });
    const rule = confirmed.state.rules.find((r) => r.rule.effect.type === "recommend" && r.rule.effect.action === action);
    if (rule === undefined) throw new Error(`rule for ${action} not confirmed`);
    await debriefAction(base, sessionId, { action: "revise_rule", ruleId: rule.rule.id, predicate, priority: 100, quote });
  }
  await debriefAction(base, sessionId, {
    action: "confirm_stop_rule",
    decisionFamily: "reviewOutcome",
    when: {
      combinator: "all",
      conditions: [
        { feature: "jurisdictionRisk", op: "==", value: "high" },
        { feature: "accountAgeMonths", op: "<", value: 24 },
      ],
    },
    effect: { type: "forbid", action: "approve" },
    momentEntryId: frames[frames.length - 1],
    quote: stopQuote,
  });
  return sessionId;
}
