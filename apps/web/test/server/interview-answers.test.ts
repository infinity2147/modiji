/** Expert utterances: control-text refusal, answer parsing (fake Sonnet), hypothesis updates, concept proposals, explicit-statement promotion. */
import { describe, expect, it } from "vitest";
import {
  ConfirmedRuleSchema,
  ParsedAnswerSchema,
  RuleConfirmedPayloadSchema,
  parseLedgerPayload,
  rulebookFromLedger,
  type LlmAnswer,
} from "@vashistha/core";
import { ORACLE_MARKER } from "@vashistha/core/domains/kyc/oracle";
import { EngineStateResponseSchema, GateAuthorizeResponseSchema, PostUtteranceResponseSchema, QuestionQueueResponseSchema } from "../../lib/contracts/interview";
import { ApiErrorSchema } from "../../lib/contracts/casedesk";
import { engineState, unparsedAnswers } from "../../lib/server/interview/engine-state";
import { createInterviewHarness, gateRequest, utterance, type InterviewHarness, trainingCases } from "../support/interview-harness";
import { readTurn } from "../support/llm-harness";

const [ONE] = trainingCases();

const STATEMENT = "If the largest owner holds more than 25 percent and isn't verified, it always goes to enhanced review.";
const ANSWER_TEXT = `Honestly? ${STATEMENT} That's the whole reason here.`;

function answer(over: Partial<LlmAnswer> = {}): LlmAnswer {
  return { survivingCandidateIds: [], eliminatedCandidateIds: [], statedRules: [], newConcepts: [], answeredAction: null, confidence: 0.9, ...over };
}

const STATED_RULE: LlmAnswer["statedRules"][number] = {
  when: {
    combinator: "all",
    conditions: [
      { feature: "uboOwnershipPct", op: ">", value: 25 },
      { feature: "uboVerified", op: "==", value: false },
    ],
  },
  polarity: "recommend",
  action: "enhancedReview",
  approvalRole: null,
  kind: "decision",
  exactQuote: STATEMENT,
};

/** Expert session after case 1; asks (authorizes and speaks) the first queued question of `kind`. */
async function asked(h: InterviewHarness, kind: "why_probe" | "counterfactual") {
  const s = await h.session("expert");
  await h.work(s, ONE.id, "enhancedReview", "medium");
  const { queue, contextVersion } = QuestionQueueResponseSchema.parse((await h.questions(s)).body);
  const question = queue.find((q) => q.kind === kind);
  if (question === undefined) throw new Error(`no ${kind} queued`);
  const granted = GateAuthorizeResponseSchema.parse((await h.authorize(s, gateRequest(question.id, contextVersion))).body);
  expect(await readTurn(await h.llmTurn(s, granted.controlMessage))).toMatchObject({ kind: "speech", text: question.text });
  return { s, question, granted };
}

function only<T>(xs: readonly T[]): T {
  expect(xs).toHaveLength(1);
  const [x] = xs;
  if (x === undefined) throw new Error("unreachable");
  return x;
}

describe("POST utterances", () => {
  it("refuses control-message text (400) and records nothing", async () => {
    const h = createInterviewHarness();
    const { s, granted } = await asked(h, "why_probe");
    for (const text of [granted.controlMessage, ` ${granted.controlMessage} `, `as I said ⟦ctl:${"A".repeat(22)}⟧`, "prefix ⟦ctl: only"]) {
      const r = await h.utter(s, utterance(h, s, text));
      expect([r.status, ApiErrorSchema.parse(r.body).error]).toEqual([400, "control_message"]);
    }
    expect(h.ledger.list(s, { kinds: ["utterance.transcript"] })).toEqual([]);
  });

  it("records an answer to an unasked question as refused (409) and a free utterance without a question", async () => {
    const h = createInterviewHarness();
    const { s } = await asked(h, "why_probe");
    const { queue } = QuestionQueueResponseSchema.parse((await h.questions(s)).body);
    const notAsked = await h.utter(s, utterance(h, s, "Something", { questionId: queue[0]?.id }));
    expect([notAsked.status, ApiErrorSchema.parse(notAsked.body).error]).toEqual([409, "question_not_asked"]);
    const free = await h.utter(s, utterance(h, s, "Just thinking out loud."));
    expect(free.status).toBe(200);
    const e = only(h.ledger.list(s, { kinds: ["utterance.transcript"] }));
    expect(e.source).toBe("voice");
    expect(e.parentIds).toEqual([]);
  });

  it("without a parser: the answer is recorded and left unparsed (never guessed)", async () => {
    const h = createInterviewHarness();
    const { s, question } = await asked(h, "why_probe");
    const r = await h.utter(s, utterance(h, s, ANSWER_TEXT, { questionId: question.id }));
    expect(r.status).toBe(200);
    const body = PostUtteranceResponseSchema.parse(r.body);
    expect(body.parsed).toBeUndefined();
    const e = only(h.ledger.list(s, { kinds: ["utterance.transcript"] }));
    expect(e.id).toBe(body.utteranceId);
    expect(e.parentIds).toEqual([only(h.ledger.list(s, { kinds: ["gate.authorized"] })).id]);
    expect(parseLedgerPayload(e, "utterance.transcript")).toMatchObject({ text: ANSWER_TEXT, t0Ms: 10_000, t1Ms: 14_500, frameIds: [] });
    expect(h.ledger.list(s, { kinds: ["answer.parsed", "rule.confirmed"] })).toEqual([]);
    expect(unparsedAnswers(engineState(h.deps, s)).map((u) => u.entryId)).toEqual([e.id]);
    expect(h.logs.some((l) => l.includes("recorded unparsed"))).toBe(true);
  });

  it("a parser failure leaves the answer unparsed and the request succeeds", async () => {
    const h = createInterviewHarness();
    h.setModel({});
    const { s, question } = await asked(h, "why_probe");
    const r = await h.utter(s, utterance(h, s, ANSWER_TEXT, { questionId: question.id }));
    expect(r.status).toBe(200);
    expect(PostUtteranceResponseSchema.parse(r.body).parsed).toBeUndefined();
    expect(h.ledger.list(s, { kinds: ["answer.parsed"] })).toEqual([]);
    expect(unparsedAnswers(engineState(h.deps, s))).toHaveLength(1);
  });

  it("parses a counterfactual answer (fake Sonnet), applies it and regenerates the queue", async () => {
    const h = createInterviewHarness();
    h.setModel({ answer: () => answer() });
    const { s, question } = await asked(h, "counterfactual");
    const [kept, ruledOut] = question.target.candidateIds;
    if (kept === undefined || ruledOut === undefined) throw new Error("a counterfactual pits at least two candidates");
    h.setModel({
      answer: () => answer({ survivingCandidateIds: [kept], eliminatedCandidateIds: [ruledOut], answeredAction: "enhancedReview" }),
    });
    const before = EngineStateResponseSchema.parse((await h.engine(s)).body);
    const r = await h.utter(s, utterance(h, s, "Still enhanced review, the ownership alone does it.", { questionId: question.id }));
    expect(r.status).toBe(200);
    const { utteranceId, parsed } = PostUtteranceResponseSchema.parse(r.body);
    expect(ParsedAnswerSchema.parse(parsed)).toMatchObject({
      questionId: question.id,
      utteranceId,
      survivingCandidateIds: [kept],
      eliminatedCandidateIds: [ruledOut],
      answeredAction: "enhancedReview",
    });

    const parsedEntry = only(h.ledger.list(s, { kinds: ["answer.parsed"] }));
    const queuedEntry = h.ledger.list(s, { kinds: ["question.queued"] }).find((e) => parseLedgerPayload(e, "question.queued").id === question.id);
    expect(parsedEntry.source).toBe("engine");
    expect(parsedEntry.parentIds).toEqual([utteranceId, queuedEntry?.id]);
    const updates = h.ledger.list(s, { kinds: ["hypotheses.updated"] });
    const updated = updates.at(-1);
    expect(updates).toHaveLength(2);
    expect(updated?.parentIds).toEqual([parsedEntry.id]);
    expect(updated && parseLedgerPayload(updated, "hypotheses.updated")).toMatchObject({ contradiction: false });
    expect(updated && "surpriseBits" in parseLedgerPayload(updated, "hypotheses.updated")).toBe(false);

    const family = engineState(h.deps, s).families.get("reviewOutcome");
    expect(family?.knowledge.observations).toHaveLength(2);
    expect(family?.knowledge.eliminatedIds).toContain(ruledOut);
    expect(family?.set.candidates.some((c) => c.id === ruledOut)).toBe(false);
    const after = EngineStateResponseSchema.parse((await h.engine(s)).body);
    expect(after.families.find((f) => f.decisionFamily === "reviewOutcome")?.observations).toBe(2);
    expect(after.families).not.toEqual(before.families);

    const queue = QuestionQueueResponseSchema.parse((await h.questions(s)).body);
    expect(queue.queue.some((q) => q.id === question.id)).toBe(false);
    // Parser prompt: the asked question and the answer, never the oracle.
    const call = h.modelCalls.find((c) => c.kind === "answer");
    expect(call?.user).toContain(question.text);
    expect(call?.user).toContain("Still enhanced review");
    for (const c of h.modelCalls) {
      expect(`${c.system}${c.user}`).not.toContain(ORACLE_MARKER);
      expect(`${c.system}${c.user}`).not.toMatch(/nsrp\./);
    }
  });

  it("a low-confidence parse is recorded and changes nothing", async () => {
    const h = createInterviewHarness();
    h.setModel({ answer: () => answer({ confidence: 0.2, eliminatedCandidateIds: [] }) });
    const { s, question } = await asked(h, "why_probe");
    const before = engineState(h.deps, s).families.get("reviewOutcome")?.set;
    const r = await h.utter(s, utterance(h, s, "Hmm, not sure, maybe the country?", { questionId: question.id }));
    expect(PostUtteranceResponseSchema.parse(r.body).parsed?.confidence).toBe(0.2);
    expect(h.ledger.list(s, { kinds: ["answer.parsed"] })).toHaveLength(1);
    expect(h.ledger.list(s, { kinds: ["hypotheses.updated"] })).toHaveLength(1);
    expect(engineState(h.deps, s).families.get("reviewOutcome")?.set).toBe(before);
  });

  it("a why-probe answer runs the concept proposer; the concept becomes a definition probe", async () => {
    const h = createInterviewHarness();
    const quote = "it's a fresh shell company, nobody on the board has a track record";
    h.setModel({
      answer: () => answer(),
      concepts: () => ({
        concepts: [
          { name: "boardTrackRecord", label: "board track record", definition: "Whether the directors have run a business before.", type: "boolean", values: [], evidenceQuote: quote },
          { name: "pep", label: "PEP", definition: "Already a feature.", type: "boolean", values: [], evidenceQuote: quote },
        ],
      }),
    });
    const { s, question } = await asked(h, "why_probe");
    const r = await h.utter(s, utterance(h, s, `Well, ${quote}.`, { questionId: question.id }));
    expect(r.status).toBe(200);
    const proposed = only(h.ledger.list(s, { kinds: ["concept.proposed"] }));
    expect(parseLedgerPayload(proposed, "concept.proposed")).toMatchObject({ name: "boardTrackRecord", exactQuote: quote });
    expect(proposed.parentIds).toEqual([PostUtteranceResponseSchema.parse(r.body).utteranceId]);
    expect(EngineStateResponseSchema.parse((await h.engine(s)).body).undefinedConcepts).toEqual([{ name: "boardTrackRecord", label: "board track record" }]);
    const { queue } = QuestionQueueResponseSchema.parse((await h.questions(s)).body);
    expect(queue.find((q) => q.kind === "concept_definition")?.text).toBe(
      "You mentioned “board track record”. What counts as board track record, and where would I see it on screen?",
    );
    expect(h.logs.some((l) => l.includes("pep rejected"))).toBe(true);
  });
});

describe("explicit-statement promotion", () => {
  it("waits for frames: without a frame on record the statement stays an expert_statement candidate", async () => {
    const h = createInterviewHarness();
    h.setModel({ answer: () => answer({ statedRules: [STATED_RULE] }) });
    const { s, question } = await asked(h, "why_probe");
    const r = await h.utter(s, utterance(h, s, ANSWER_TEXT, { questionId: question.id }));
    expect(PostUtteranceResponseSchema.parse(r.body).parsed?.statedRules).toHaveLength(1);
    expect(h.ledger.list(s, { kinds: ["rule.confirmed"] })).toEqual([]);
    expect(h.logs.some((l) => l.includes("no frame on record"))).toBe(true);
    expect(engineState(h.deps, s).families.get("reviewOutcome")?.set.candidates.some((c) => c.origin === "expert_statement")).toBe(true);
    expect(EngineStateResponseSchema.parse((await h.engine(s)).body).confirmedRules).toBe(0);
  });

  it("with frames: a valid ConfirmedRule whose quote, times and frames all trace to the expert's utterance", async () => {
    const h = createInterviewHarness();
    h.setModel({ answer: () => answer({ statedRules: [STATED_RULE] }) });
    const { s, question } = await asked(h, "why_probe");
    const frame = h.frame(s);
    const r = await h.utter(s, utterance(h, s, ANSWER_TEXT, { questionId: question.id }));
    const { utteranceId } = PostUtteranceResponseSchema.parse(r.body);
    const utteranceEntry = h.ledger.get(utteranceId);
    if (utteranceEntry === undefined) throw new Error("utterance missing");
    const spoken = parseLedgerPayload(utteranceEntry, "utterance.transcript");
    expect(spoken.frameIds).toEqual([frame.id]);

    const confirmed = only(h.ledger.list(s, { kinds: ["rule.confirmed"] }));
    expect(confirmed.source).toBe("engine");
    expect(confirmed.parentIds).toEqual([only(h.ledger.list(s, { kinds: ["answer.parsed"] })).id, utteranceId]);
    const { rule } = RuleConfirmedPayloadSchema.parse(confirmed.payload);
    expect(ConfirmedRuleSchema.safeParse(rule).success).toBe(true);
    const [quote] = rule.evidence;
    expect(quote.kind).toBe("expert_quote");
    expect(quote).toMatchObject({ utteranceId, relation: "supports", provenance: "human_voice" });
    expect(spoken.text).toContain(quote.exactQuote);
    expect(quote.t0Ms).toBeGreaterThanOrEqual(spoken.t0Ms);
    expect(quote.t1Ms).toBeLessThanOrEqual(spoken.t1Ms);
    for (const id of quote.frameIds) expect(h.ledger.get(id)).toMatchObject({ kind: "frame.received", source: "client", sessionId: s });
    expect(rule).toMatchObject({
      decisionFamily: "reviewOutcome",
      kind: "decision",
      effect: { type: "recommend", action: "enhancedReview" },
      predicate: { and: [{ ">": [{ var: "uboOwnershipPct" }, 25] }, { "==": [{ var: "uboVerified" }, false] }] },
      confirmedBy: [{ method: "explicit_statement", ledgerEntryId: utteranceId }],
      revision: 1,
    });
    const book = rulebookFromLedger(h.ledger.list(s));
    expect(book.rules.map((x) => x.id)).toEqual([rule.id]);
    expect(book.rejected).toEqual([]);
    expect(EngineStateResponseSchema.parse((await h.engine(s)).body)).toMatchObject({ confirmedRules: 1, rulebookRevision: 1 });
  });

  it("a quote the expert did not say verbatim is rejected by the engine's conversion and never promoted", async () => {
    const h = createInterviewHarness();
    h.setModel({ answer: () => answer({ statedRules: [{ ...STATED_RULE, exactQuote: "Anything above a quarter, unverified, is enhanced review." }] }) });
    const { s, question } = await asked(h, "why_probe");
    h.frame(s);
    const r = await h.utter(s, utterance(h, s, ANSWER_TEXT, { questionId: question.id }));
    expect(PostUtteranceResponseSchema.parse(r.body).parsed?.statedRules).toEqual([]);
    expect(h.ledger.list(s, { kinds: ["rule.confirmed"] })).toEqual([]);
    expect(h.logs.some((l) => l.includes("quote is not verbatim"))).toBe(true);
  });
});

describe("question rephrasing", () => {
  it("Sonnet's wording is queued only when it keeps the target; the template stands otherwise", async () => {
    const h = createInterviewHarness();
    h.setModel({ rephrase: (user) => ({ text: "Quick one: would something else change your call here?", targetFeature: /<target_feature>(.*?)</.exec(user)?.[1] === "null" ? null : "jurisdictionRisk" }) });
    const s = await h.session("expert");
    await h.work(s, ONE.id, "enhancedReview", "medium");
    const { queue } = QuestionQueueResponseSchema.parse((await h.questions(s)).body);
    const why = queue.find((q) => q.kind === "why_probe");
    expect(why?.text).toBe("Quick one: would something else change your call here?");
    // Counterfactuals must keep their moved value; this rewording drops it, so the template stands.
    for (const q of queue.filter((x) => x.kind === "counterfactual")) expect(q.text.startsWith("If ")).toBe(true);
    expect(h.modelCalls.filter((c) => c.kind === "rephrase")).toHaveLength(queue.length);
  });
});
