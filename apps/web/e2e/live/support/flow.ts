/** Shared live-run flow: answering the agent's questions and finishing a run with evidence. */
import { expect, type Page } from "@playwright/test";
import { analyzeRun } from "./analyze";
import { answerFor } from "./answers";
import type { Expert } from "./expert";
import { conversationIds, evidencePath, saveRun, summarizeRun, thinVad } from "./report";

export type Asked = { caseId: string; question: string; agentStart: number; agentEnd: number; answer: string; rule: string; answeredAt: number | null };

export type AnswerStyle = (expert: Expert, answer: string, caseId: string) => Promise<void>;

export const plainAnswer: AnswerStyle = async (expert, answer) => {
  await expert.say(answer, "answer");
};

/**
 * Waits up to `waitMs` for the agent to ask, answers ~0.8 s after it stops, and repeats (the engine may
 * queue a follow-up) up to `max` questions. Returns the questions asked.
 */
export async function answerQuestions(
  expert: Expert,
  caseId: string,
  opts: { waitMs: number; max: number; style?: AnswerStyle; log: Asked[] },
): Promise<number> {
  let n = 0;
  while (n < opts.max) {
    const turn = await expert.waitForAgentTurn(opts.waitMs);
    if (turn === null) break;
    n += 1;
    const { text, rule } = answerFor(turn.text, caseId);
    const record: Asked = { caseId, question: turn.text, agentStart: turn.start, agentEnd: turn.end, answer: text, rule, answeredAt: null };
    opts.log.push(record);
    await expert.page.waitForTimeout(800);
    record.answeredAt = Date.now();
    await (opts.style ?? plainAnswer)(expert, text, caseId);
  }
  return n;
}

export async function finishRun(
  expert: Expert,
  opts: { group: string; name: string; title: string; asked: Asked[]; notes?: string[]; extra?: Record<string, unknown> },
): Promise<ReturnType<typeof analyzeRun>> {
  const page: Page = expert.page;
  await page.waitForTimeout(4000);
  await page.screenshot({ path: evidencePath(opts.group, `${opts.name}-final.png`) });
  await expert.endInterview();
  await page.waitForTimeout(1500);
  const events = await expert.events();
  const ledger = await expert.ledger();
  const analysis = analyzeRun(events, ledger);
  const conv = conversationIds(events, ledger);
  const questionsLine = [
    "",
    "Questions and scripted answers (synthetic voice input, ElevenLabs TTS):",
    ...opts.asked.map((a) => `  [${a.caseId}] Q: "${a.question}"\n      A (${a.rule}): "${a.answer}"`),
    ...(opts.notes ?? []),
  ];
  const summary = summarizeRun(opts.title, expert.sessionId, conv, analysis, questionsLine);
  saveRun(opts.group, opts.name, expert, { conversationIds: conv, analysis, asked: opts.asked, spoken: expert.spoken, ...opts.extra, events: thinVad(events), ledger }, summary);
  console.info(summary);
  expect(conv.length).toBeGreaterThan(0);
  return analysis;
}
