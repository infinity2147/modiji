/**
 * @live @p4 — P4 acceptance, LIVE (real Sonnet answer parsing on production; plan §11 P4): one
 * Expert/Training run over the 3 training cases. The scripted expert (synthetic voice input, ElevenLabs
 * TTS) answers the questions the interviewer ACTUALLY asks; the first answer on each case teaches the
 * case's reason, and two answers state stop-rules outright ("Never approve …"). Asserted from the
 * production ledger: ≥1 threshold-style rule or candidate, ≥1 guardrail/exception confirmed, ≥1
 * unresolved concept surfaced, every rule.confirmed passes evidence validation. Evidence:
 * docs/evidence/live/p4/. The session id is written for the P8 run (exports round trip).
 */
import { writeFileSync } from "node:fs";
import { expect, test } from "@playwright/test";
import { allAnswerLines, answerFor, CASE_PLANS, STOP_RULE_HIGH_RISK, STOP_RULE_PEP } from "./support/answers";
import { Expert } from "./support/expert";
import { finishRun, type Asked } from "./support/flow";
import { p4Checks } from "./support/p4-checks";
import { evidencePath } from "./support/report";

const GROUP = "p4";
const TRAINING = ["NS-2026-0101", "NS-2026-0102", "NS-2026-0103"];

/**
 * The first answer on each case: its reason, and for two cases an explicit stop-rule. Variant
 * `LIVE_P4_VARIANT=single-sentence` makes each stop-rule the whole answer (one ASR segment): attempt 2
 * showed the bridge tags only the FIRST transcript segment after a question as the answer, so a
 * stop-rule said as a second sentence never reaches the answer parser (reported as a bug).
 */
const VARIANT = process.env.LIVE_P4_VARIANT ?? "";
const SINGLE = VARIANT.startsWith("single-sentence");
/**
 * `single-sentence+concept` also names, in the first case's answer, something the feature model does
 * not have (the age of the company-registry extract), to exercise concept surfacing; and asks at most
 * one question per case before moving on, to leave live budget for the stop-rules.
 */
const CONCEPT = VARIANT === "single-sentence+concept";
const PER_CASE = CONCEPT ? 1 : 2;
const TEACHING: Record<string, string> = {
  "NS-2026-0101": CONCEPT
    ? "Anything over twenty-five percent that isn't verified goes to enhanced review, and so does a company registry extract older than six months."
    : (CASE_PLANS["NS-2026-0101"]?.why ?? ""),
  "NS-2026-0102": SINGLE
    ? STOP_RULE_HIGH_RISK
    : `Country risk alone isn't it. A long relationship with verified funds lets me approve high-risk customers. But ${STOP_RULE_HIGH_RISK.charAt(0).toLowerCase()}${STOP_RULE_HIGH_RISK.slice(1)}`,
  "NS-2026-0103": SINGLE ? STOP_RULE_PEP : `She's a politically exposed person, so it goes to the compliance officer. ${STOP_RULE_PEP}`,
};

test("@live @p4 hypothesis engine on the 3 training cases (real Sonnet)", async ({ page, request }) => {
  const expert = await Expert.open(page, request);
  await expert.startSession("Training");
  writeFileSync(evidencePath(GROUP, "latest-session.txt"), `${expert.sessionId}\n`);
  await expert.preload([...allAnswerLines(TRAINING, true), ...Object.values(TEACHING)]);
  await expert.shareScreen();
  await expert.startInterview();
  await page.waitForTimeout(1000);
  const asked: Asked[] = [];

  const reconnects: string[] = [];
  /** Teaching answers not yet said (a lost or skipped question must not lose a stop-rule statement). */
  const pending: string[] = [];
  const ask = async (caseId: string, waitMs: number): Promise<boolean> => {
    if (await expert.ensureConnected()) reconnects.push(`${caseId} @ ${new Date().toISOString()}`);
    const turn = await expert.waitForAgentTurn(waitMs);
    if (turn === null) return false;
    const owed = pending.shift();
    const chosen = owed !== undefined ? { text: owed, rule: "teaching_answer" } : answerFor(turn.text, caseId);
    const record: Asked = { caseId, question: turn.text, agentStart: turn.start, agentEnd: turn.end, answer: chosen.text, rule: chosen.rule, answeredAt: null };
    asked.push(record);
    await page.waitForTimeout(800);
    record.answeredAt = Date.now();
    await expert.say(chosen.text, "answer");
    return true;
  };

  for (const [i, caseId] of TRAINING.entries()) {
    const plan = CASE_PLANS[caseId];
    if (plan === undefined) throw new Error(caseId);
    await expert.resetCursor();
    await expert.openCase(i);
    await page.waitForTimeout(1200);
    await expert.rate(plan.rating);
    await expert.decide(plan.outcome);
    pending.push(TEACHING[caseId] ?? plan.why);
    for (let n = 0; n < PER_CASE; n += 1) if (!(await ask(caseId, 15_000))) break;
  }
  // Remaining questions about the last case, until every teaching answer (incl. both stop-rules) was said.
  for (let n = 0; n < 4 && (n < 2 || pending.length > 0); n += 1) if (!(await ask("NS-2026-0103", 12_000))) break;
  // Let the last answer be parsed (Sonnet) before reading the ledger: with no next question, its answer window
  // closes after 12 s without a new transcript segment (ANSWER_WINDOW_IDLE_MS), then the parse runs.
  await page.waitForTimeout(25_000);
  const analysis = await finishRun(expert, {
    group: GROUP,
    name: `p4-run-${expert.sessionId}`,
    title: "P4 live run — 3 training cases, real Sonnet answer parsing (LIVE, production)",
    asked,
    notes: [`Reconnects (conversation had ended): ${reconnects.length ? reconnects.join(", ") : "none"}`, `Teaching answers never said: ${pending.length}`],
    extra: { reconnects, unsaidTeachingAnswers: pending },
  });

  const ledger = await expert.ledger();
  const checks = p4Checks(ledger);
  const engine = (await (await request.get(`/api/sessions/${expert.sessionId}/engine`)).json()) as { undefinedConcepts?: unknown[] };
  const rulebook = (await (await request.get("/api/rulebook")).json()) as { revision: number; rules: { id: string }[] };
  writeFileSync(evidencePath(GROUP, `p4-checks-${expert.sessionId}.json`), `${JSON.stringify({ sessionId: expert.sessionId, variant: VARIANT || "default", checks, undefinedConceptsFromEngineRoute: engine.undefinedConcepts, rulebookAfter: rulebook }, null, 2)}\n`);
  const lines = [
    `P4 checks — session ${expert.sessionId} (expert speech: synthetic voice input, ElevenLabs TTS)`,
    `threshold-style rule or candidate: ${checks.pass.thresholdRuleOrCandidate} (confirmed threshold rules: ${checks.thresholdRules.length}; stated threshold candidates: ${checks.statedThresholdCandidates.length}; hypothesis threshold candidates: ${checks.hypothesisThresholdCandidates.length})`,
    `guardrail/exception confirmed: ${checks.pass.guardrailOrExceptionConfirmed} (${checks.guardrailsOrExceptions.length})`,
    `unresolved concept surfaced: ${checks.pass.unresolvedConceptSurfaced} (${checks.unresolvedConcepts.join(", ")})`,
    `every promoted rule passes evidence validation: ${checks.pass.everyPromotedRuleValid} (${checks.rulesConfirmed.length} rule.confirmed)`,
    `answers parsed (answer.parsed): ${checks.answersParsed}`,
    "",
    ...checks.rulesConfirmed.map(
      (r) => `rule ${r.ruleId} [${r.kind}] effect=${JSON.stringify(r.effect)} method=${r.method.join(",")} provenance=${r.provenance.join(",")} frames=${r.frames} valid=${r.valid}${r.problems.length ? ` problems=${r.problems.join("; ")}` : ""}\n  predicate=${JSON.stringify(r.predicate)}\n  quote="${r.quotes.join(" | ")}"`,
    ),
    "",
    `Production rulebook after the run: revision ${rulebook.revision}, ${rulebook.rules.length} rules`,
  ];
  writeFileSync(evidencePath(GROUP, `p4-checks-${expert.sessionId}.txt`), `${lines.join("\n")}\n`);
  console.info(lines.join("\n"));

  await page.goto(`/debrief/${expert.sessionId}`);
  await page.waitForTimeout(4000);
  await page.screenshot({ path: evidencePath(GROUP, `p4-debrief-${expert.sessionId}.png`), fullPage: true });
  await page.goto(`/workmap/${expert.sessionId}`);
  await page.waitForTimeout(4000);
  await page.screenshot({ path: evidencePath(GROUP, `p4-workmap-${expert.sessionId}.png`), fullPage: true });

  expect.soft(analysis.interruptions.count, "interruptions").toBe(0);
  expect.soft(checks.pass.thresholdRuleOrCandidate, "≥1 threshold rule or candidate").toBe(true);
  expect.soft(checks.pass.guardrailOrExceptionConfirmed, "≥1 guardrail/exception confirmed").toBe(true);
  expect.soft(checks.pass.unresolvedConceptSurfaced, "≥1 unresolved concept surfaced").toBe(true);
  expect.soft(checks.pass.everyPromotedRuleValid, "every promoted rule passes evidence validation").toBe(true);
});
