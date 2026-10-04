/**
 * Ledger integrity of the whole interview loop: every entry conforms to the kind registry (source and
 * payload), control traffic never becomes evidence, and a restarted process derives the same engine
 * state from the ledger alone.
 */
import { describe, expect, it } from "vitest";
import { isLedgerKind, parseLedgerPayload, parseControlMessage, type LedgerEntry, type LlmAnswer } from "@vashistha/core";
import { EngineStateResponseSchema, GateAuthorizeResponseSchema, QuestionQueueResponseSchema } from "../../lib/contracts/interview";
import { engineState, type EngineState } from "../../lib/server/interview/engine-state";
import { handleCommitDecision, handleInterlockCheck } from "../../lib/server/casedesk/interlock";
import { fixtureRulebook, jsonRequest } from "../support/casedesk-harness";
import { createInterviewHarness, gateRequest, utterance, type InterviewHarness, trainingCases } from "../support/interview-harness";
import { readTurn } from "../support/llm-harness";

const [ONE, TWO, THREE] = trainingCases();
const QUOTE = "If the largest owner holds more than 25 percent and isn't verified, it always goes to enhanced review.";

const PARSE: LlmAnswer = {
  survivingCandidateIds: [],
  eliminatedCandidateIds: [],
  statedRules: [
    {
      when: { combinator: "all", conditions: [{ feature: "uboOwnershipPct", op: ">", value: 25 }, { feature: "uboVerified", op: "==", value: false }] },
      polarity: "recommend",
      action: "enhancedReview",
      approvalRole: null,
      kind: "decision",
      exactQuote: QUOTE,
    },
  ],
  newConcepts: [],
  answeredAction: null,
  confidence: 0.9,
};

/** The full loop: three expert decisions, gate, custom-LLM speech, agent and expert utterances, promotion, off-record round trip. */
async function fullLoop(h: InterviewHarness): Promise<string> {
  h.setModel({ answer: () => PARSE, concepts: () => ({ concepts: [] }) });
  const s = await h.session("expert");
  await h.work(s, ONE.id, "enhancedReview", "medium");
  const { queue, contextVersion } = QuestionQueueResponseSchema.parse((await h.questions(s)).body);
  const asked = queue.find((q) => q.kind === "why_probe") ?? queue[0];
  if (!asked) throw new Error("empty queue");
  const granted = GateAuthorizeResponseSchema.parse((await h.authorize(s, gateRequest(asked.id, contextVersion))).body);
  await readTurn(await h.llmTurn(s, "Expert speech that arrives without authorization"));
  expect(await readTurn(await h.llmTurn(s, granted.controlMessage))).toMatchObject({ kind: "speech" });
  expect((await h.agentSaid(s, { conversationId: "conv-1", text: asked.text, questionId: asked.id })).status).toBe(204);
  h.frame(s);
  expect((await h.answerWith(s, utterance(h, s, `Look. ${QUOTE}`, { questionId: asked.id }))).status).toBe(200);
  await h.offRecord(s, true);
  await h.offRecord(s, false);
  await h.work(s, TWO.id, "approve", "high");
  await h.work(s, THREE.id, "escalateCompliance", "high");
  return s;
}

/** Everything the engine derived, in a comparable form. */
function snapshot(state: EngineState): unknown {
  return {
    families: [...state.families.entries()].map(([id, f]) => [id, f.set, f.knowledge, f.decisions]),
    concepts: state.undefinedConcepts,
    questions: [...state.questions.entries()],
    utterances: [...state.utterances.entries()],
    transcript: state.transcript,
    answers: [...state.answers.entries()],
    rulebook: state.rulebook,
    skipped: state.skipped,
  };
}

describe("interview ledger", () => {
  it("every entry of a full CaseDesk + interview flow conforms to the kind registry", async () => {
    const h = createInterviewHarness();
    const s = await fullLoop(h);
    // A blocked decision and an acknowledged needs_approval in a novice session add the interlock kinds.
    h.casedesk.rulebook = fixtureRulebook;
    const novice = await h.session("novice");
    for (const [edits, action, override] of [
      [{ riskRating: "high" }, "approve", undefined],
      [{ riskRating: "medium" }, "approve", { kind: "acknowledged", note: "Senior reviewer agreed." }],
    ] as const) {
      const check = (await (await handleInterlockCheck(jsonRequest("/api/interlock/check", { sessionId: novice, caseId: ONE.id, edits, proposedAction: action }), h.casedesk)).json()) as { checkId: string };
      await handleCommitDecision(jsonRequest(`/api/sessions/${novice}/decisions`, { caseId: ONE.id, edits, action, checkId: check.checkId, ...(override && { override }) }), novice, h.casedesk);
    }
    const entries: LedgerEntry[] = [...h.ledger.list(s), ...h.ledger.list(novice)];
    const kinds = new Set(entries.map((e) => e.kind));
    for (const kind of [
      "session.started", "screen.event", "interlock.check", "interlock.blocked", "case.decision", "hypotheses.updated", "question.queued",
      "question.dropped", "gate.authorized", "gate.control_message", "llm.turn_decision", "agent.utterance", "frame.received",
      "utterance.transcript", "answer.parsed", "rule.confirmed", "privacy.off_record", "privacy.on_record",
    ])
      expect(kinds, kind).toContain(kind);
    for (const e of entries) {
      const { kind } = e;
      expect(isLedgerKind(kind), kind).toBe(true);
      if (isLedgerKind(kind)) expect(() => parseLedgerPayload(e, kind), `${kind} (${e.source})`).not.toThrow();
    }
    expect(engineState(h.deps, s).skipped).toEqual([]);
  });

  it("control messages never become evidence: evidence holds the expert's utterances, no system_control", async () => {
    const h = createInterviewHarness();
    const s = await fullLoop(h);
    const evidence = h.ledger.evidence(s);
    expect(evidence.some((e) => e.source === "system_control")).toBe(false);
    const utterances = evidence.filter((e) => e.kind === "utterance.transcript");
    expect(utterances.length).toBeGreaterThan(0);
    for (const u of utterances) {
      const { text } = parseLedgerPayload(u, "utterance.transcript");
      expect(parseControlMessage(text)).toBeNull();
      expect(text).not.toContain("⟦ctl:");
      expect(u.source).toBe("voice");
    }
    // The control message itself exists only as a system_control digest (never the nonce, never as text).
    const control = h.ledger.list(s, { kinds: ["gate.control_message"] });
    expect(control.length).toBeGreaterThan(0);
    expect(control.every((e) => e.source === "system_control" && !JSON.stringify(e.payload).includes("⟦ctl:"))).toBe(true);
  });

  it("a restarted process derives the same engine state, queue and responses from the ledger alone", async () => {
    const h = createInterviewHarness();
    const s = await fullLoop(h);
    const live = snapshot(engineState(h.deps, s));
    const engine = EngineStateResponseSchema.parse((await h.engine(s)).body);
    const queue = QuestionQueueResponseSchema.parse((await h.questions(s)).body);
    expect(engine.confirmedRules).toBe(1);
    h.restart();
    expect(h.deps.store.states.size).toBe(0);
    expect(snapshot(engineState(h.deps, s))).toEqual(live);
    expect(EngineStateResponseSchema.parse((await h.engine(s)).body)).toEqual(engine);
    expect(QuestionQueueResponseSchema.parse((await h.questions(s)).body)).toEqual(queue);
  });
});
