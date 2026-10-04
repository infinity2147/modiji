/**
 * @live @p3 — P3 acceptance, LIVE against production (plan §11 P3): five scripted typing/talking runs in
 * Expert sessions with the (synthetic) screen shared and a real ElevenLabs interviewer over WebRTC.
 * Expert speech is synthetic voice input (ElevenLabs TTS) played into the harness microphone, so the
 * script knows its own speech, typing and scrolling windows exactly. Per run: questions asked,
 * interruptions (must be 0), authorization latency p50/p95/max, first-audio p50/p95, and control turns
 * never in evidence. Evidence: docs/evidence/live/p3/.
 *
 * Answers avoid stop-rule wording ("never …"), so these runs add no forbid/approval rules to the shared
 * production rulebook (see support/answers.ts).
 */
import { expect, test } from "@playwright/test";
import { allAnswerLines, CASE_PLANS } from "./support/answers";
import { Expert } from "./support/expert";
import { answerQuestions, finishRun, type Asked, type AnswerStyle } from "./support/flow";
import { evidencePath } from "./support/report";

const GROUP = "p3";
const TRAINING = ["NS-2026-0101", "NS-2026-0102", "NS-2026-0103"];
const PRACTICE = ["NS-2026-0301", "NS-2026-0302", "NS-2026-0303", "NS-2026-0304", "NS-2026-0305", "NS-2026-0306"];

function plan(caseId: string) {
  const p = CASE_PLANS[caseId];
  if (p === undefined) throw new Error(`no plan for ${caseId}`);
  return p;
}

async function begin(expert: Expert, set: "Training" | "Practice", extraLines: string[], caseIds: string[]) {
  await expert.startSession(set);
  await expert.preload([...allAnswerLines(caseIds, false), ...extraLines]);
  await expert.shareScreen();
  await expert.startInterview();
  await expert.page.waitForTimeout(1000);
}

function expectGreen(a: Awaited<ReturnType<typeof finishRun>>) {
  expect.soft(a.interruptions.count, "interruptions").toBe(0);
  expect.soft(a.controlNeverEvidence.ok, "control turns never evidence").toBe(true);
  for (const v of a.authorizationLatencyMs.values) expect.soft(v, "authorization latency ≤ 250 ms").toBeLessThanOrEqual(250);
  expect.soft(a.counts.questionsAuthorized, "at least one question asked").toBeGreaterThan(0);
}



test("@live @p3 run A: expert types a note while talking", async ({ page, request }) => {
  const expert = await Expert.open(page, request);
  const NARRATE = "Let me jot down the ownership details while I read through this file.";
  const notes = ["UBO 35 pct unverified - registry extract pending", "existing client 36m, funds verified, HR country", "PEP individual, low risk country"];
  await begin(expert, "Training", [NARRATE], TRAINING);
  const asked: Asked[] = [];
  // Answer while typing a note about it at the same time.
  const typingAnswer: AnswerStyle = async (e, answer) => {
    await Promise.all([e.say(answer, "answer+typing"), e.page.waitForTimeout(600).then(() => e.typeNote("noted: answered agent", 90))]);
  };
  for (const [i, caseId] of TRAINING.entries()) {
    await expert.resetCursor();
    await expert.openCase(i);
    await Promise.all([expert.say(NARRATE, "narrate+typing"), expert.typeNote(notes[i] ?? "note", 80)]);
    await expert.rateByKeyboard(plan(caseId).rating);
    await expert.decide(plan(caseId).outcome);
    // A question is now queued; keep typing — the gate must wait.
    await expert.typeNote("follow up: file the review memo", 110);
    await answerQuestions(expert, caseId, { waitMs: 14_000, max: 2, style: typingAnswer, log: asked });
    if (i === 0) await page.screenshot({ path: evidencePath(GROUP, "run-a-after-first-question.png") });
  }
  await answerQuestions(expert, TRAINING.at(-1) ?? "", { waitMs: 8000, max: 2, style: typingAnswer, log: asked });
  const a = await finishRun(expert, { group: GROUP, name: `run-a-typing-${expert.sessionId}`, title: "P3 run A — expert types a note while talking (LIVE, production)", asked });
  expectGreen(a);
});

test("@live @p3 run B: long pause, then resumes mid-answer", async ({ page, request }) => {
  const expert = await Expert.open(page, request);
  const THINK = "Hmm, let me think about this one.";
  const RESUME = "Okay. The key points here are the ownership and the country.";
  const WELL = "Well, let me think.";
  await begin(expert, "Training", [THINK, RESUME, WELL], TRAINING);
  const asked: Asked[] = [];
  // Starts answering, falls silent for 3.5 s mid-answer, then resumes.
  const pausingAnswer: AnswerStyle = async (e, answer) => {
    await e.say(WELL, "answer-part-1");
    await e.mark("long_pause_start");
    await e.page.waitForTimeout(3500);
    await e.mark("long_pause_end");
    await e.say(answer, "answer-part-2");
  };
  for (const [i, caseId] of TRAINING.entries()) {
    await expert.resetCursor();
    await expert.openCase(i);
    await expert.say(THINK, "think-aloud");
    await expert.mark("long_pause_start");
    await page.waitForTimeout(6000);
    await expert.mark("long_pause_end");
    await expert.say(RESUME, "resume");
    await expert.rate(plan(caseId).rating);
    await expert.decide(plan(caseId).outcome);
    await answerQuestions(expert, caseId, { waitMs: 14_000, max: 2, style: pausingAnswer, log: asked });
  }
  await answerQuestions(expert, TRAINING.at(-1) ?? "", { waitMs: 8000, max: 2, style: pausingAnswer, log: asked });
  const a = await finishRun(expert, { group: GROUP, name: `run-b-pause-${expert.sessionId}`, title: "P3 run B — long pause, then resumes mid-answer (LIVE, production)", asked });
  expectGreen(a);
});

test("@live @p3 run C: rapid case navigation and scrolling", async ({ page, request }) => {
  const expert = await Expert.open(page, request);
  await begin(expert, "Training", [], TRAINING);
  const asked: Asked[] = [];
  for (const [i, caseId] of TRAINING.entries()) {
    await expert.resetCursor();
    await expert.openCase(i);
    await expert.scrollCase(14, 320, 180);
    // Flip quickly through the queue and back.
    for (const j of [(i + 1) % 3, (i + 2) % 3, i]) {
      await expert.openCase(j);
      await page.waitForTimeout(350);
    }
    await expert.scrollCase(8, 260, 160);
    await expert.rate(plan(caseId).rating);
    await expert.decide(plan(caseId).outcome);
    // The question is queued now; keep moving for ~6 s (the gate must wait), then stop and listen.
    const until = Date.now() + 6000;
    let k = 0;
    while (Date.now() < until) {
      await expert.openCase((i + 1 + k) % 3);
      await expert.scrollCase(3, 300, 150);
      k += 1;
    }
    await expert.openCase(i);
    await answerQuestions(expert, caseId, { waitMs: 14_000, max: 2, log: asked });
  }
  await answerQuestions(expert, TRAINING.at(-1) ?? "", { waitMs: 8000, max: 2, log: asked });
  const a = await finishRun(expert, { group: GROUP, name: `run-c-scrolling-${expert.sessionId}`, title: "P3 run C — rapid case navigation and scrolling (LIVE, production)", asked });
  expect.soft(a.counts.scrollEvents, "scrolling actually happened").toBeGreaterThan(20);
  expectGreen(a);
});

test("@live @p3 run D: short noisy utterances near the VAD threshold", async ({ page, request }) => {
  const expert = await Expert.open(page, request);
  const SHORT = ["Okay.", "Mm-hm.", "Right.", "Yeah.", "Hmm."];
  await begin(expert, "Training", SHORT, TRAINING);
  const asked: Asked[] = [];
  // Quiet broadband noise under everything; answers at full level over the noise.
  await expert.noise(0.012);
  const gains = [0.12, 0.2, 0.3, 0.4, 0.15, 0.25];
  let g = 0;
  const murmur = async (count: number, gapMs: number) => {
    for (let k = 0; k < count; k += 1) {
      const gain = gains[g % gains.length] ?? 0.2;
      await expert.say(SHORT[g % SHORT.length] ?? "Okay.", `short@${gain}`, gain);
      g += 1;
      await page.waitForTimeout(gapMs);
    }
  };
  for (const [i, caseId] of TRAINING.entries()) {
    await expert.resetCursor();
    await expert.openCase(i);
    await murmur(3, 900);
    await expert.rate(plan(caseId).rating);
    await expert.decide(plan(caseId).outcome);
    // Question pending: short murmurs with < 1.2 s gaps keep the floor (if the VAD hears them).
    await murmur(5, 1000);
    await answerQuestions(expert, caseId, { waitMs: 14_000, max: 2, log: asked });
  }
  await answerQuestions(expert, TRAINING.at(-1) ?? "", { waitMs: 8000, max: 2, log: asked });
  await expert.noise(0);
  const a = await finishRun(expert, { group: GROUP, name: `run-d-noisy-${expert.sessionId}`, title: "P3 run D — short noisy utterances near the VAD threshold (LIVE, production)", asked });
  expectGreen(a);
});

test("@live @p3 run E: several decisions exercise the live budget", async ({ page, request }) => {
  const expert = await Expert.open(page, request);
  await begin(expert, "Practice", [], PRACTICE);
  const asked: Asked[] = [];
  for (const [i, caseId] of PRACTICE.entries()) {
    await expert.resetCursor();
    await expert.openCase(i);
    await page.waitForTimeout(800);
    await expert.rate(plan(caseId).rating);
    await expert.decide(plan(caseId).outcome);
    await answerQuestions(expert, caseId, { waitMs: 12_000, max: 2, log: asked });
  }
  await answerQuestions(expert, PRACTICE.at(-1) ?? "", { waitMs: 10_000, max: 2, log: asked });
  // What the server still has queued (unspent because of the budget) and what the gate says.
  const queue = (await (await request.get(`/api/sessions/${expert.sessionId}/questions`)).json()) as { queue: unknown[]; asked: unknown[] };
  await page.getByRole("button", { name: "Engineering view" }).click();
  await page.waitForTimeout(600);
  await page.screenshot({ path: evidencePath(GROUP, `run-e-budget-engineering-view-${expert.sessionId}.png`) });
  const hud = (await page.getByRole("region", { name: "Engineering view" }).textContent()) ?? "";
  const a = await finishRun(expert, {
    group: GROUP,
    name: `run-e-budget-${expert.sessionId}`,
    title: "P3 run E — six decisions exercise the live budget (5 per 10 min) (LIVE, production)",
    asked,
    notes: [`Server queue at the end: ${queue.queue.length} queued, ${queue.asked.length} asked.`, `Engineering view text at the end: ${hud.slice(0, 1200)}`],
    extra: { finalQueue: queue, engineeringView: hud },
  });
  expect.soft(a.counts.questionsAuthorized, "live budget: at most 5 questions in 10 minutes").toBeLessThanOrEqual(5);
  expectGreen(a);
});
