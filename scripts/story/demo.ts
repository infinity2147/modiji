/**
 * Demo video (~3 min, plan.md §10 beats). Capture and the recorded debrief come from the VERIFIED REPLAY of
 * the genuine live run (banner visible, its recorded conversation audio muxed in); the completed debrief,
 * Work Map and tutor are genuine local flows on a production build of HEAD; the agent beat shows the
 * committed transcript of the live Claude run. Called by video.ts.
 */
import { agentCard, endCard, hookCard, proofCard, thesisCard } from "./cards";
import { confirmDebriefProposals, expertSessionWithScreens, seedTutorRulebook } from "./lib/flows";
import type { Page } from "./lib/playwright";
import type { StoryContext } from "./video";

const LOCAL = (commit: string, extra: string): string =>
  `<b style="color:#c9b6ff">LOCAL RUN</b> · production build of <code>${commit}</code> on this machine · ${extra}`;

export async function recordDemo(x: StoryContext): Promise<string> {
  const { prod, ev, name, replay } = x;
  const A = x.serverA.baseUrl;
  const B = x.serverB.baseUrl;
  const replayLabel = `<b style="color:#c9b6ff">VERIFIED REPLAY of a recorded run</b> · production, ${replay.recordedAt}<br/>Expert voice: <b>synthetic voice input</b> (ElevenLabs TTS, “Matilda”) · nothing here is live`;

  // Local flows are set up first (public APIs + real CaseDesk screenshots as frames), outside the recording.
  const debriefSession = await expertSessionWithScreens(x.browser, A);
  await confirmDebriefProposals(A, debriefSession.sessionId);
  await seedTutorRulebook(x.browser, B, ev.live.blockedQuote.text);

  await prod.beat("hook", async (b) => {
    b.mark();
    await b.page.setContent(hookCard(ev, name));
    await b.say("demo/hook");
    await b.wait(500);
  });

  await prod.beat("capture", async (b) => {
    const p = b.page;
    await p.goto(`${A}/replay/${replay.bundleId}`);
    await p.getByTestId("replay-banner-text").waitFor();
    await p.waitForTimeout(1000);
    b.mark();
    await b.label(replayLabel, "bottom-right");
    await p.getByLabel("Speed").selectOption("2");
    await p.getByRole("button", { name: "Play" }).click();
    const n1 = b.say("demo/capture-1");
    const position = async (): Promise<number> => Number(await p.getByTestId("replay-position").getAttribute("data-n"));
    const started = Date.now();
    while ((await position()) < 66 && Date.now() - started < 60_000) await p.waitForTimeout(200);
    const pause = p.getByRole("button", { name: "Pause" });
    if (await pause.isVisible()) await pause.click();
    await n1;
    // The recorded conversation audio: the agent's third question, then the expert's answer (synthetic voice).
    await seek(p, 68);
    const clip = b.clip(replay.audio.file, replay.audio.from, replay.audio.to, replay.audio.lines, 1.4);
    await p.waitForTimeout(700);
    await seek(p, 71);
    await p.waitForTimeout((replay.audio.answerEnd - replay.audio.from) * 1000 - 700);
    await seek(p, 73);
    await clip;
    await seek(p, 80);
    await p.waitForTimeout(1500);
    await p.getByTestId("rule").filter({ hasText: "relationship age below 24 months" }).first().scrollIntoViewIfNeeded();
    await b.say("demo/capture-2");
    await b.wait(400);
  });

  await prod.beat("debrief-recorded", async (b) => {
    const p = b.page;
    await p.goto(`${A}/replay/${replay.bundleId}`);
    await p.getByTestId("replay-banner-text").waitFor();
    await seek(p, replay.debriefAt);
    await p.getByRole("button", { name: "Debrief" }).first().click();
    await p.getByTestId("coverage-panel").waitFor();
    await p.waitForTimeout(1200);
    b.mark();
    await b.label(replayLabel, "bottom-right");
    await b.say("demo/debrief-1");
    await b.wait(300);
  });

  await prod.beat("debrief-local", async (b) => {
    const p = b.page;
    await p.goto(`${A}/debrief/${debriefSession.sessionId}`);
    await p.getByRole("heading", { name: "Debrief" }).waitFor();
    await p.getByTestId("coverage-panel").waitFor();
    await p.waitForTimeout(800);
    b.mark();
    await b.label(LOCAL(x.commit, "expert answers <b>typed</b> · teach-back is the labelled template (model calls off)"), "bottom-right");
    const n = b.say("demo/debrief-2");
    await completeDebrief(p);
    await n;
    await b.wait(2200);

    // Work Map: built by code; the lineage trace walks the ledger.
    await p.getByRole("link", { name: "Work Map" }).click();
    await p.getByRole("heading", { name: "Work Map" }).waitFor();
    await b.label(LOCAL(x.commit, "frames are screenshots of the real CaseDesk uploaded through the frames route (headless browsers cannot screen-share)"), "bottom-right");
    const w = b.say("demo/workmap");
    await p.waitForTimeout(2500);
    await p.getByTestId("step").first().getByRole("button", { name: /^Trace step 1$/ }).click();
    await p.getByTestId("lineage-chain").locator('[data-stage="confirmed_rule"]').first().waitFor();
    await p.waitForTimeout(4500);
    await p.keyboard.press("Escape");
    await p.getByTestId("reason-quote").first().getByRole("button", { name: "Trace expert quote" }).click();
    await w;
    await b.wait(1200);
  });

  await prod.beat("tutor", async (b) => {
    const p = b.page;
    await p.goto(`${B}/sandbox`);
    await p.getByRole("button", { name: "Start session" }).waitFor();
    await p.waitForTimeout(600);
    b.mark();
    await b.label(LOCAL(x.commit, "a different local server whose expert rules were typed in a local debrief (the live stop-rule sentence re-entered) · tutor voice not configured locally"), "bottom-left");
    const n = b.say("demo/tutor");
    await p.getByRole("radio", { name: /^Novice practice/ }).click();
    await p.getByRole("radio", { name: /^Held-out/ }).click();
    await p.getByRole("button", { name: "Start session" }).click();
    const item = p.getByRole("list", { name: "Cases" }).getByRole("button").filter({ hasText: "NS-2026-0201" });
    await item.click();
    const prompt = p.getByRole("region", { name: "What would the expert decide?" });
    await prompt.waitFor();
    await p.waitForTimeout(1200);
    await prompt.getByRole("radio", { name: "Approve onboarding" }).click();
    await p.waitForTimeout(600);
    await prompt.getByRole("button", { name: "Lock in prediction" }).click();
    await p.getByTestId("reveal-card").waitFor();
    await p.waitForTimeout(3800);
    await p.getByRole("radio", { name: "Approve onboarding" }).click();
    await p.getByTestId("intervention-card").waitFor();
    await p.getByTestId("intervention-card").scrollIntoViewIfNeeded();
    await p.waitForTimeout(3500);
    await p.getByRole("button", { name: "Save decision" }).click();
    await p.getByRole("dialog").filter({ hasText: "Blocked by a confirmed guardrail" }).waitFor();
    await p.waitForTimeout(3500);
    await p.keyboard.press("Escape");
    await p.waitForTimeout(500);
    await p.getByRole("radio", { name: "Send to enhanced review" }).click();
    await p.getByRole("button", { name: "Save decision" }).click();
    await p.getByText("Decision committed").first().waitFor();
    await p.getByRole("region", { name: "Mastery ladder" }).scrollIntoViewIfNeeded();
    await n;
    await b.wait(1500);
  });

  await prod.beat("agent", async (b) => {
    b.mark();
    await b.page.setContent(agentCard(ev));
    await b.say("demo/agent");
    await b.wait(1500);
  });

  await prod.beat("proof", async (b) => {
    b.mark();
    await b.page.setContent(proofCard(ev));
    await b.say("demo/proof");
    await b.wait(800);
  });

  await prod.beat("close", async (b) => {
    b.mark();
    await b.page.setContent(thesisCard(ev));
    await b.wait(400);
    await b.say("demo/close");
    await b.wait(1200);
  });

  await prod.beat("end", async (b) => {
    b.mark();
    await b.page.setContent(
      endCard(ev, {
        title: `${name} — demo`,
        commit: x.commit,
        narrator: "Daniel",
        lines: [
          `<strong>Verified replay of a recorded run</strong>: bundle <code>${replay.bundleId}</code> (${ev.replay.entries.text} entries, chain ${ev.replay.head.text}…), recorded on production ${replay.recordedAt}. The expert in it is <strong>synthetic voice input</strong> (ElevenLabs TTS, “Matilda”); the audio you heard is that run's recorded conversation.`,
          `Agent block: the committed transcript of the live run with real Claude (${ev.live.agentModel.text}), ${ev.live.agentSource}.`,
          `Apprentice-Bench uses a simulated expert (deterministic oracle).`,
        ],
      }),
    );
    await b.wait(6500);
  });
  return debriefSession.sessionId;
}

/** The debrief e2e's flow, at a watchable pace: witnesses answered, teach-back, a correction, coverage closed. */
export async function completeDebrief(p: Page): Promise<void> {
  const witness = (kind: string) => p.getByTestId("witness").and(p.locator(`[data-kind="${kind}"]`)).and(p.locator('[data-status="queued"]'));
  const answer = async (card: ReturnType<typeof witness>, quote: string, submit: string): Promise<void> => {
    const form = card.locator("form").filter({ has: p.getByRole("button", { name: submit }) });
    await form.getByLabel("Your words (recorded as evidence)").pressSequentially(quote, { delay: 14 });
    await form.getByRole("button", { name: submit }).click();
  };
  const unresolved = witness("unresolved").first();
  await unresolved.scrollIntoViewIfNeeded();
  await p.waitForTimeout(600);
  await unresolved.getByLabel("Decision").selectOption("approve");
  await answer(unresolved, "Verified owner and no PEP — that's a straight approval.", "Add rule for these cases");
  await p.waitForTimeout(900);
  const conflict = witness("conflict").first();
  await conflict.getByLabel("Request documents").check();
  await answer(conflict, "Documents first — the PEP review comes after we know who the owner is.", "This one applies");
  await p.getByTestId("rule-diff").filter({ hasText: "rule revised" }).waitFor();
  await p.waitForTimeout(700);
  await p.getByRole("button", { name: "Write teach-back" }).click();
  const teachBack = p.getByTestId("teachback");
  await teachBack.getByTestId("teachback-text").filter({ hasText: "Did I get that right?" }).waitFor({ timeout: 60_000 });
  await teachBack.scrollIntoViewIfNeeded();
  await p.waitForTimeout(1500);
  const docsRule = p.getByTestId("rule").filter({ hasText: "request documents" }).first();
  await docsRule.getByRole("button", { name: "Correct this rule" }).click();
  await docsRule.getByLabel("Condition feature").selectOption({ label: "Largest beneficial owner share" });
  await docsRule.getByLabel("Condition operator").selectOption(">");
  await docsRule.getByLabel("Condition value").fill("25");
  const form = docsRule.locator("form").filter({ has: p.getByRole("button", { name: "Correct teach-back" }) });
  await form.getByLabel("Your words (recorded as evidence)").pressSequentially("Not quite — only when the owner holds more than a quarter.", { delay: 14 });
  await form.getByRole("button", { name: "Correct teach-back" }).click();
  const diff = p.getByTestId("rule-diff").filter({ hasText: "predicate" });
  await diff.waitFor();
  await diff.scrollIntoViewIfNeeded();
  await p.waitForTimeout(1800);
  const gap = witness("unresolved").first();
  await gap.waitFor();
  await answer(gap, "Small unverified owners aren't mine to decide — escalate to the controller.", "Escalate to controller");
  await p.locator('[data-testid="witness"][data-status="acknowledged"]').first().waitFor();
  const threshold = witness("boundary").first();
  await answer(threshold, "Exactly 25% is fine — only above a quarter.", "Rule is right at the threshold");
  const confirmForm = teachBack.locator("form").filter({ has: p.getByRole("button", { name: "Confirm teach-back" }) });
  await confirmForm.waitFor();
  await confirmForm.getByLabel("Your words (recorded as evidence)").pressSequentially("Yes, that's right.", { delay: 14 });
  await confirmForm.getByRole("button", { name: "Confirm teach-back" }).click();
  const closed = p.getByTestId("coverage-closed");
  await closed.waitFor();
  await p.getByTestId("coverage-panel").scrollIntoViewIfNeeded();
}

export async function seek(p: Page, n: number): Promise<void> {
  await p.getByLabel("Seek (recorded entries)").fill(String(n));
  await p.getByTestId("replay-position").and(p.locator(`[data-n="${n}"]`)).waitFor();
}
