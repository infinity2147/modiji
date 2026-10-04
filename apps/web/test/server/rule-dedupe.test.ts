/**
 * Rule de-duplication on the server (live BUGS #9: production held 23 rules, 9 distinct, because every
 * expert session re-promoted the same statement). Re-confirming a rule the expert already has — same
 * decision family, canonical predicate and effect — revises that rule (`rule.revised`: revision + 1, the
 * new confirmation and quote appended); nothing new → 409 `rule_exists` (typed) or nothing recorded
 * (voice). Identical rules of different experts stay separate; the team rulebook shows them once.
 */
import { rm } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import {
  ActionIdSchema,
  RuleConfirmedPayloadSchema,
  RuleRevisedPayloadSchema,
  teamRulebook,
  type LlmAnswer,
} from "@vashistha/core";
import { ApiErrorSchema } from "../../lib/contracts/casedesk";
import { ExpertActionResponseSchema, type ExpertActionRequest } from "../../lib/contracts/debrief";
import { GateAuthorizeResponseSchema, QuestionQueueResponseSchema } from "../../lib/contracts/interview";
import { handleExpertAction } from "../../lib/server/debrief/handlers";
import { jsonRequest } from "../support/casedesk-harness";
import { path, reply, world, type World } from "../support/debrief-harness";
import { createInterviewHarness, gateRequest, trainingCases, utterance, type InterviewHarness } from "../support/interview-harness";
import { readTurn } from "../support/llm-harness";

const QUOTE = "Never approve a customer on a high-risk country list at desk level.";
const AGAIN = "High-risk country list: we never approve those at the desk.";
const APPROVE = ActionIdSchema.parse("approve");
const [ONE] = trainingCases();

function stopRuleAnswer(exactQuote: string): LlmAnswer {
  return {
    survivingCandidateIds: [],
    eliminatedCandidateIds: [],
    statedRules: [
      {
        when: { combinator: "all", conditions: [{ feature: "jurisdictionRisk", op: "==", value: "high" }] },
        polarity: "forbid",
        action: "approve",
        approvalRole: null,
        kind: "guardrail",
        exactQuote,
      },
    ],
    newConcepts: [],
    answeredAction: null,
    confidence: 0.95,
  };
}

/** A session of `expert` (unnamed: its own expert) that decides case 1, is asked the first question and states the stop-rule by voice on screen. */
async function statesStopRule(h: InterviewHarness, quote: string, expert?: { name: string; language: "en" }): Promise<string> {
  h.setModel({ answer: () => stopRuleAnswer(quote) });
  const s = await h.session("expert", expert);
  await h.work(s, ONE.id, "enhancedReview", "medium");
  const { queue, contextVersion } = QuestionQueueResponseSchema.parse((await h.questions(s)).body);
  const question = queue.find((q) => q.kind === "why_probe") ?? queue[0];
  if (question === undefined) throw new Error("nothing queued");
  const granted = GateAuthorizeResponseSchema.parse((await h.authorize(s, gateRequest(question.id, contextVersion))).body);
  expect(await readTurn(await h.llmTurn(s, granted.controlMessage))).toMatchObject({ kind: "speech" });
  h.frame(s);
  expect((await h.utter(s, utterance(h, s, quote, { questionId: question.id }))).status).toBe(200);
  h.advance(60_000);
  await h.idle(s);
  return s;
}

describe("voice: the same expert restating a rule in a later session", () => {
  it("revises the rule the expert already has instead of confirming a duplicate", async () => {
    const h = createInterviewHarness();
    const asha = { name: "Asha Rao", language: "en" } as const;
    const first = await statesStopRule(h, QUOTE, asha);
    const second = await statesStopRule(h, AGAIN, asha);

    const [confirmed, ...moreConfirmed] = [first, second].flatMap((s) => h.ledger.list(s, { kinds: ["rule.confirmed"] }));
    expect(moreConfirmed).toEqual([]);
    const { rule: original } = RuleConfirmedPayloadSchema.parse(confirmed?.payload);
    const [revised, ...moreRevised] = h.ledger.list(second, { kinds: ["rule.revised"] });
    expect(moreRevised).toEqual([]);
    const { rule, reason } = RuleRevisedPayloadSchema.parse(revised?.payload);
    expect(rule).toMatchObject({ id: original.id, revision: 2, expertId: "asha-rao", effect: { type: "forbid", action: APPROVE } });
    expect(rule.evidence.flatMap((e) => (e.kind === "expert_quote" ? [e.exactQuote] : []))).toEqual([QUOTE, AGAIN]);
    expect(rule.confirmedBy).toHaveLength(2);
    expect(reason).toContain("re-confirmed by asha-rao");
    expect(revised?.parentIds).toContain(confirmed?.id);

    const book = h.deps.rulebook();
    expect(book.rejected).toEqual([]);
    expect(book.rules.map((r) => [r.id, r.revision])).toEqual([[original.id, 2]]);
  });

  it("unnamed sessions are different experts: two rules, which the team rulebook shows once with both quotes", async () => {
    const h = createInterviewHarness();
    await statesStopRule(h, QUOTE);
    await statesStopRule(h, AGAIN);
    const book = h.deps.rulebook();
    expect(book.rules).toHaveLength(2);
    const team = teamRulebook(book, []);
    expect(team.rules).toHaveLength(1);
    expect(team.merged).toHaveLength(1);
    expect(team.rules[0]?.evidence.flatMap((e) => (e.kind === "expert_quote" ? [e.exactQuote] : []))).toEqual([QUOTE, AGAIN]);
  });
});

describe("typed: the debrief's stop-rule restated", () => {
  const STOP_RULE: ExpertActionRequest = {
    action: "confirm_stop_rule",
    decisionFamily: "reviewOutcome",
    when: { combinator: "all", conditions: [{ feature: "jurisdictionRisk", op: "==", value: "high" }] },
    effect: { type: "forbid", action: APPROVE },
    quote: QUOTE,
  };
  const post = async (w: World, body: unknown) => reply(await handleExpertAction(jsonRequest(path(w.sessionId, "debrief"), body), w.sessionId, w.deps));

  it("in new words revises the rule (one rule, both quotes); the same words again add nothing (409 rule_exists, no trace)", async () => {
    const w = await world();
    try {
      expect((await post(w, STOP_RULE)).status).toBe(200);
      const r = await post(w, { ...STOP_RULE, quote: AGAIN });
      expect(r.status, JSON.stringify(r.body)).toBe(200);
      const { derivedIds, state } = ExpertActionResponseSchema.parse(r.body);
      expect(derivedIds.map((id) => w.ledger.get(id)?.kind)).toContain("rule.revised");
      // (The seeded session already has another stop-rule: never approve a PEP.)
      const stop = state.rules.filter((v) => v.rule.effect.type === "forbid" && JSON.stringify(v.rule.predicate).includes("jurisdictionRisk"));
      expect(stop).toHaveLength(1);
      expect(stop[0]?.rule.revision).toBe(2);
      expect(stop[0]?.rule.evidence.flatMap((e) => (e.kind === "expert_quote" ? [e.exactQuote] : []))).toEqual([QUOTE, AGAIN]);

      const before = w.ledger.list(w.sessionId).length;
      const again = await post(w, { ...STOP_RULE, quote: AGAIN });
      expect(again.status).toBe(409);
      expect(ApiErrorSchema.parse(again.body).error).toBe("rule_exists");
      expect(w.ledger.list(w.sessionId)).toHaveLength(before);
    } finally {
      w.opened.close();
      await rm(w.dataDir, { recursive: true, force: true });
    }
  });
});
