/**
 * Stop-rules end to end on the server (plan §7.3, §7.7, §10): an expert says or types "Never approve a
 * customer on a high-risk country list at desk level" → a confirmed guardrail with `forbid approve`, the
 * exact quote and real redacted screen frames → `checkAction` forbids approving such a case → `/mcp`
 * check_action blocks an agent with the expert's quote → the tutor's guardrail monitor intervenes.
 * Without a screen frame neither path confirms anything. Real ledger, real Z3, fake model only.
 */
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { rm } from "node:fs/promises";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  ActionIdSchema,
  ConfirmedRuleSchema,
  RuleConfirmedPayloadSchema,
  checkAction,
  parseLedgerPayload,
  recordLookup,
  type ConfirmedRule,
  type LlmAnswer,
} from "@vashistha/core";
import { KYC_DOMAIN, caseFeatures, findKycCase } from "@vashistha/core/domains/kyc";
import { ApiErrorSchema } from "../../lib/contracts/casedesk";
import { ExpertActionResponseSchema, type ExpertActionRequest } from "../../lib/contracts/debrief";
import { GateAuthorizeResponseSchema, PostUtteranceResponseSchema, QuestionQueueResponseSchema } from "../../lib/contracts/interview";
import { handleExpertAction } from "../../lib/server/debrief/handlers";
import { engineState } from "../../lib/server/interview/engine-state";
import { createMcpEndpoint } from "../../lib/server/debrief/mcp";
import { evaluateSelection } from "../../lib/server/tutor/monitor";
import { interventionText } from "../../lib/server/tutor/rules";
import { jsonRequest } from "../support/casedesk-harness";
import { getState, path, reply, world, type World } from "../support/debrief-harness";
import { createInterviewHarness, gateRequest, trainingCases, utterance, type InterviewHarness } from "../support/interview-harness";
import { readTurn } from "../support/llm-harness";

const QUOTE = "Never approve a customer on a high-risk country list at desk level.";
const HIGH_RISK = { "==": [{ var: "jurisdictionRisk" }, "high"] };
/** Held-out NS-2026-0201: a new company from a high-risk country — the unseen case of the demo. */
const UNSEEN = "NS-2026-0201";
const APPROVE = ActionIdSchema.parse("approve");

function unseenFeatures() {
  const found = findKycCase(UNSEEN);
  if (found === undefined) throw new Error(`no case ${UNSEEN}`);
  return recordLookup(caseFeatures(found));
}

/** What the enforcement layer makes of a confirmed stop-rule: the interlock, the MCP agent export and the tutor. */
async function expectEnforced(rule: ConfirmedRule, mcpUrl: string): Promise<void> {
  const result = checkAction({ rules: [rule], features: unseenFeatures(), action: APPROVE, domain: KYC_DOMAIN });
  expect(result).toMatchObject({ decision: "forbid", matchedRules: [rule.id] });
  expect(result.evidence[0]?.exactQuote).toBe(QUOTE);
  expect(checkAction({ rules: [rule], features: unseenFeatures(), action: ActionIdSchema.parse("enhancedReview"), domain: KYC_DOMAIN }).decision).toBe("allow");

  const res = await fetch(mcpUrl, {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json, text/event-stream" },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: { name: "check_action", arguments: { context: { case: { jurisdictionRisk: "high", customerStatus: "new" } }, proposedAction: "approve" } },
    }),
  });
  expect(res.status).toBe(200);
  const body = (await res.json()) as { result: { structuredContent: { decision: string; matchedRules: string[]; explanation: string } } };
  expect(body.result.structuredContent).toMatchObject({ decision: "forbid", matchedRules: expect.arrayContaining([rule.id]) as unknown });
  expect(body.result.structuredContent.explanation).toContain(QUOTE);

  const selection = evaluateSelection([rule], unseenFeatures(), APPROVE);
  expect(selection).toMatchObject({ trigger: "guardrail_violation", stopRules: [rule] });
  const spoken = interventionText({ rule, trigger: selection.trigger, proposedAction: APPROVE, missingFeatures: [] });
  expect(spoken).toContain(`"${QUOTE}"`);
  expect(spoken.startsWith("Careful — never approve onboarding when country risk")).toBe(true);
}

/** An in-process `/mcp` serving whatever rulebook `rules()` returns. */
async function mcpServer(rules: () => readonly ConfirmedRule[]): Promise<{ url: string; close: () => Promise<void> }> {
  const server: Server = createServer((req, res) => {
    void createMcpEndpoint({ env: { NODE_ENV: "test" }, rulebook: rules, rulebookRevision: () => rules().length })(req, res);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return {
    url: `http://127.0.0.1:${(server.address() as AddressInfo).port}/mcp`,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

// ── Typed: the debrief's explicit "Add a stop-rule" action ──

const STOP_RULE: ExpertActionRequest = {
  action: "confirm_stop_rule",
  decisionFamily: "reviewOutcome",
  when: { combinator: "all", conditions: [{ feature: "jurisdictionRisk", op: "==", value: "high" }] },
  effect: { type: "forbid", action: APPROVE },
  quote: QUOTE,
};

async function post(w: World, body: unknown) {
  return reply(await handleExpertAction(jsonRequest(path(w.sessionId, "debrief"), body), w.sessionId, w.deps));
}

describe("typed stop-rule (debrief confirm_stop_rule)", () => {
  let w: World;
  let mcp: Awaited<ReturnType<typeof mcpServer>>;

  beforeAll(async () => {
    w = await world();
    mcp = await mcpServer(() => w.deps.rulebook().rules.filter((r) => r.evidence[0].exactQuote === QUOTE));
  }, 60_000);

  afterAll(async () => {
    await mcp.close();
    w.opened.close();
    await rm(w.dataDir, { recursive: true, force: true });
  });

  it("confirms a guardrail `forbid approve` with the exact typed quote and the session's real redacted frame", async () => {
    const r = await post(w, STOP_RULE);
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    const { statementId, derivedIds, state } = ExpertActionResponseSchema.parse(r.body);
    const statement = w.ledger.get(statementId);
    expect(statement).toMatchObject({ kind: "expert.statement", source: "expert" });
    expect(parseLedgerPayload(statement!, "expert.statement")).toEqual({ text: QUOTE, intent: "confirm_stop_rule", target: { action: "approve" } });

    const view = state.rules.find((v) => v.rule.evidence[0].exactQuote === QUOTE);
    if (view === undefined) throw new Error("stop-rule not in the rulebook");
    const { rule } = view;
    expect(ConfirmedRuleSchema.safeParse(rule).success).toBe(true);
    expect(rule).toMatchObject({
      decisionFamily: "reviewOutcome",
      kind: "guardrail",
      predicate: HIGH_RISK,
      effect: { type: "forbid", action: "approve" },
      priority: 40,
      confirmedBy: [{ method: "debrief", ledgerEntryId: statementId }],
      revision: 1,
    });
    expect(view.then).toBe("never approve onboarding");
    const [quote] = rule.evidence;
    expect(quote).toMatchObject({ utteranceId: statementId, exactQuote: QUOTE, relation: "supports", provenance: "human_text" });
    // Frames: real `frame.received` entries of this session, never a DOM event.
    for (const id of quote.frameIds) expect(w.ledger.get(id)).toMatchObject({ kind: "frame.received", source: "client", sessionId: w.sessionId });
    const confirmed = derivedIds.map((id) => w.ledger.get(id)).find((e) => e?.kind === "rule.confirmed");
    expect(confirmed?.parentIds[0]).toBe(statementId);
    expect(RuleConfirmedPayloadSchema.parse(confirmed?.payload).rule.id).toBe(rule.id);

    await expectEnforced(rule, mcp.url);
  });

  it("ties the quote to an explicit moment: the frame of that decision, never a later one", async () => {
    const s = await getState(w);
    const first = s.decisions[0];
    if (first === undefined) throw new Error("no decision");
    const r = await post(w, { ...STOP_RULE, effect: { type: "require_approval", role: "compliance_officer", action: "approve" }, momentEntryId: first.entryId, quote: "Anything from a high-risk country needs compliance sign-off." });
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    const rule = ExpertActionResponseSchema.parse(r.body).state.rules.find((v) => v.rule.effect.type === "require_approval")?.rule;
    expect(rule).toMatchObject({ kind: "guardrail", effect: { type: "require_approval", role: "compliance_officer" } });
    const frames = rule?.evidence[0].frameIds ?? [];
    const decision = w.ledger.get(first.entryId);
    expect(frames.length).toBeGreaterThan(0);
    for (const id of frames) expect(w.ledger.get(id)?.sequence).toBeLessThan(decision?.sequence ?? -1);
    expect(rule?.evidence).toContainEqual({ kind: "observed_decision", ledgerEntryId: first.entryId });
    const verdict = checkAction({ rules: rule === undefined ? [] : [rule], features: unseenFeatures(), action: ActionIdSchema.parse("reject"), domain: KYC_DOMAIN });
    expect(verdict.decision).toBe("needs_approval");
  });

  it("refuses an invalid predicate, a foreign action, an unknown moment and a duplicate — leaving no trace", async () => {
    const before = w.ledger.list(w.sessionId).length;
    const codes = async (body: unknown) => ApiErrorSchema.parse((await post(w, body)).body).error;
    expect(await codes({ ...STOP_RULE, when: { combinator: "all", conditions: [{ feature: "jurisdictionRisk", op: ">", value: 3 }] } })).toBe("invalid_predicate");
    expect(await codes({ ...STOP_RULE, when: { combinator: "all", conditions: [{ feature: "countryList", op: "==", value: "high" }] } })).toBe("invalid_predicate");
    expect(await codes({ ...STOP_RULE, effect: { type: "forbid", action: "rateHigh" } })).toBe("invalid_action");
    expect(await codes({ ...STOP_RULE, effect: { type: "require_approval", role: "my_manager", action: "approve" } })).toBe("invalid_request");
    expect(await codes({ ...STOP_RULE, effect: { type: "forbid", action: "reject" }, momentEntryId: "not-an-entry" })).toBe("unknown_moment");
    expect(await codes(STOP_RULE)).toBe("rule_exists");
    expect(w.ledger.list(w.sessionId)).toHaveLength(before);
  });
});

describe("frames are mandatory evidence", () => {
  it("debrief: a DOM-only session (screen never shared) refuses every confirmation with 409 no_screen_frame", async () => {
    const w = await world({ screenFrames: false });
    try {
      const s = await getState(w);
      expect(s.screenFrames).toBe(0);
      const before = w.ledger.list(w.sessionId).length;
      const stop = await post(w, STOP_RULE);
      expect(stop.status).toBe(409);
      expect(ApiErrorSchema.parse(stop.body)).toMatchObject({ error: "no_screen_frame", detail: expect.stringContaining("share your screen during capture") as unknown });
      const proposal = s.proposals[0];
      if (proposal === undefined) throw new Error("no proposal");
      const confirm = await post(w, { action: "confirm_candidate", candidateId: proposal.candidateId, decisionFamily: proposal.decisionFamily, quote: "Yes, that's how I decide it." });
      expect(confirm.status).toBe(409);
      expect(ApiErrorSchema.parse(confirm.body).error).toBe("no_screen_frame");
      expect(w.ledger.list(w.sessionId)).toHaveLength(before);
    } finally {
      w.opened.close();
      await rm(w.dataDir, { recursive: true, force: true });
    }
  }, 60_000);

  it("interview: a stop-rule stated by voice without a frame on record is not promoted", async () => {
    const h = createInterviewHarness();
    h.setModel({ answer: () => stopRuleAnswer() });
    const { s, question } = await asked(h);
    const r = await h.utter(s, utterance(h, s, QUOTE, { questionId: question.id }));
    expect(PostUtteranceResponseSchema.parse(r.body).parsed?.statedRules).toHaveLength(1);
    expect(h.ledger.list(s, { kinds: ["rule.confirmed"] })).toEqual([]);
    expect(h.logs.some((l) => l.includes("no frame on record"))).toBe(true);
  });
});

// ── Voice: the interview's explicit-statement promotion ──

const [ONE] = trainingCases();

function stopRuleAnswer(): LlmAnswer {
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
        exactQuote: QUOTE,
      },
    ],
    newConcepts: [],
    answeredAction: null,
    confidence: 0.95,
  };
}

/** Expert session after case 1; asks (authorizes and speaks) the first queued why-probe. */
async function asked(h: InterviewHarness) {
  const s = await h.session("expert");
  await h.work(s, ONE.id, "enhancedReview", "medium");
  const { queue, contextVersion } = QuestionQueueResponseSchema.parse((await h.questions(s)).body);
  const question = queue.find((q) => q.kind === "why_probe") ?? queue[0];
  if (question === undefined) throw new Error("nothing queued");
  const granted = GateAuthorizeResponseSchema.parse((await h.authorize(s, gateRequest(question.id, contextVersion))).body);
  expect(await readTurn(await h.llmTurn(s, granted.controlMessage))).toMatchObject({ kind: "speech" });
  return { s, question };
}

describe("spoken stop-rule (interview explicit statement)", () => {
  it("'Never approve …' becomes a guardrail forbidding approve — not a recommendation to approve — with quote, times and frames", async () => {
    const h = createInterviewHarness();
    h.setModel({ answer: () => stopRuleAnswer() });
    const { s, question } = await asked(h);
    const frame = h.frame(s);
    const r = await h.utter(s, utterance(h, s, QUOTE, { questionId: question.id }));
    const { utteranceId } = PostUtteranceResponseSchema.parse(r.body);

    const [confirmed, ...more] = h.ledger.list(s, { kinds: ["rule.confirmed"] });
    expect(more).toEqual([]);
    const { rule } = RuleConfirmedPayloadSchema.parse(confirmed?.payload);
    expect(rule).toMatchObject({
      kind: "guardrail",
      predicate: HIGH_RISK,
      effect: { type: "forbid", action: "approve" },
      priority: 40,
      confirmedBy: [{ method: "explicit_statement", ledgerEntryId: utteranceId }],
    });
    expect(rule.evidence[0]).toMatchObject({ utteranceId, exactQuote: QUOTE, t0Ms: 10_000, t1Ms: 14_500, frameIds: [frame.id], provenance: "human_voice" });
    // A stop-rule is not a decision hypothesis: the posterior holds no expert_statement candidate for it.
    const [parsed] = h.ledger.list(s, { kinds: ["answer.parsed"] });
    expect(engineState(h.deps, s).answers.get(parsed?.id ?? "")?.statedRules.map((o) => o.status)).toEqual(["guardrail"]);
    expect(engineState(h.deps, s).families.get("reviewOutcome")?.set.candidates.some((c) => c.origin === "expert_statement")).toBe(false);

    const mcp = await mcpServer(() => [rule]);
    try {
      await expectEnforced(rule, mcp.url);
    } finally {
      await mcp.close();
    }
  });
});
