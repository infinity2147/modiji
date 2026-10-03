/** Question queue, gate authorization (happy path and every refusal), context versions, agent utterances. */
import { describe, expect, it } from "vitest";
import { QuestionSchema, parseLedgerPayload, type Question } from "@vashistha/core";
import {
  GateAuthorizeResponseSchema,
  GateRefusalSchema,
  QuestionQueueResponseSchema,
} from "../../lib/contracts/interview";
import { ApiErrorSchema } from "../../lib/contracts/casedesk";
import { handlePostEvents } from "../../lib/server/casedesk/events";
import { domEvent, jsonRequest, T0 } from "../support/casedesk-harness";
import { createInterviewHarness, gateRequest, type InterviewHarness, trainingCases } from "../support/interview-harness";
import { readTurn } from "../support/llm-harness";

const [ONE, TWO] = trainingCases();

async function queueOf(h: InterviewHarness, s: string) {
  const r = await h.questions(s);
  expect(r.status).toBe(200);
  return QuestionQueueResponseSchema.parse(r.body);
}

async function expertAfterOneCase(): Promise<{ h: InterviewHarness; s: string; decision: string }> {
  const h = createInterviewHarness();
  const s = await h.session("expert");
  const decision = await h.work(s, ONE.id, "enhancedReview", "medium");
  return { h, s, decision };
}

function refusal(body: unknown): string {
  return GateRefusalSchema.parse(ApiErrorSchema.parse(body).error);
}

/** Queues a question directly (as the P6 tutor will), registry-validated like every engine write. */
function queueQuestion(h: InterviewHarness, s: string, over: Partial<Question>): Question {
  const question = QuestionSchema.parse({
    id: `q-${over.kind ?? "x"}`,
    sessionId: s,
    kind: "prediction",
    text: "What would you decide on this case?",
    target: { caseId: ONE.id, candidateIds: [] },
    value: 1,
    reason: "test",
    ephemeral: true,
    createdAt: T0,
    contextVersion: h.authorizations.getContextVersion(s),
    parentIds: [],
    ...over,
  });
  h.ledger.append({
    sessionId: s,
    source: "engine",
    kind: "question.queued",
    occurredAt: T0,
    traceId: "trace-test",
    parentIds: [],
    schemaVersion: 1,
    privacyEpoch: h.epoch(s),
    payload: question,
  });
  return question;
}

describe("question queue", () => {
  it("is generated on each committed expert decision: hypotheses.updated, then queued questions under it", async () => {
    const { h, s, decision } = await expertAfterOneCase();
    const updated = h.ledger.list(s, { kinds: ["hypotheses.updated"] });
    expect(updated).toHaveLength(1);
    expect(updated[0]?.parentIds).toEqual([decision]);
    const queued = h.ledger.list(s, { kinds: ["question.queued"] });
    expect(queued.length).toBeGreaterThan(0);
    expect(queued.length).toBeLessThanOrEqual(5);
    for (const e of queued) {
      const q = parseLedgerPayload(e, "question.queued");
      expect(e.source).toBe("engine");
      expect(e.parentIds).toEqual(expect.arrayContaining([decision, updated[0]?.id]));
      expect(q.target.caseId).toBe(ONE.id);
      expect(q.text.split(/\s+/).length).toBeLessThanOrEqual(25);
    }
    const queue = await queueOf(h, s);
    // open_case, field_change and the decision each bumped the context version.
    expect(queue.contextVersion).toBe(3);
    expect(queue.queue.map((q) => q.id).sort()).toEqual(queued.map((e) => parseLedgerPayload(e, "question.queued").id).sort());
    expect(queue.queue.every((q, i, all) => i === 0 || (all[i - 1]?.value ?? 0) >= q.value)).toBe(true);
    expect(queue).toMatchObject({ asked: [], offRecord: false });
  });

  it("supersedes the previous queue on the next decision", async () => {
    const { h, s } = await expertAfterOneCase();
    const first = await queueOf(h, s);
    const d2 = await h.work(s, TWO.id, "approve", "high");
    const second = await queueOf(h, s);
    const dropped = h.ledger.list(s, { kinds: ["question.dropped"] }).map((e) => parseLedgerPayload(e, "question.dropped"));
    expect(dropped.map((d) => d.questionId).sort()).toEqual(first.queue.map((q) => q.id).sort());
    expect(dropped.every((d) => d.reason === "superseded")).toBe(true);
    expect(second.queue.every((q) => q.parentIds.includes(d2) && q.target.caseId === TWO.id)).toBe(true);
  });

  it("keeps the queue on open_case / field_change but reports it at the bumped context version", async () => {
    const { h, s } = await expertAfterOneCase();
    const before = await queueOf(h, s);
    const res = await handlePostEvents(
      jsonRequest(`/api/sessions/${s}/events`, { events: [domEvent({ frameSeq: 50, kind: "open_case", caseId: TWO.id, sessionEpoch: 0 })] }),
      s,
      h.casedesk,
    );
    expect(res.status).toBe(200);
    const after = await queueOf(h, s);
    expect(after.contextVersion).toBe(before.contextVersion + 1);
    expect(after.queue.map((q) => q.id)).toEqual(before.queue.map((q) => q.id));
    expect(after.queue.every((q) => q.contextVersion === after.contextVersion)).toBe(true);
    // The old version is refused; the current one is accepted.
    const top = after.queue[0];
    if (!top) throw new Error("empty queue");
    expect(refusal((await h.authorize(s, gateRequest(top.id, before.contextVersion))).body)).toBe("context_changed");
    expect((await h.authorize(s, gateRequest(top.id, after.contextVersion))).status).toBe(200);
  });

  it("novice decisions bump the context version but never feed the engine", async () => {
    const h = createInterviewHarness();
    const s = await h.session("novice");
    await h.work(s, ONE.id, "approve", "low");
    expect(h.authorizations.getContextVersion(s)).toBe(3);
    expect(h.ledger.list(s, { kinds: ["hypotheses.updated", "question.queued"] })).toEqual([]);
    const engine = await h.engine(s);
    expect(engine.status).toBe(200);
    expect((engine.body as { families: { observations: number }[] }).families.every((f) => f.observations === 0)).toBe(true);
  });
});

describe("POST gate/authorize", () => {
  it("issues a 4 s single-use authorization for the queued text and records gate.authorized", async () => {
    const { h, s } = await expertAfterOneCase();
    const { queue, contextVersion } = await queueOf(h, s);
    const top = queue[0];
    if (!top) throw new Error("empty queue");
    const r = await h.authorize(s, gateRequest(top.id, contextVersion));
    expect(r.status).toBe(200);
    const granted = GateAuthorizeResponseSchema.parse(r.body);
    expect(granted).toMatchObject({ text: top.text, authorization: { sessionId: s, questionId: top.id, contextVersion, expiresAt: T0 + 4000 } });
    expect(granted.controlMessage).toBe(`⟦ctl:${granted.authorization.nonce}⟧`);
    const [authorized] = h.ledger.list(s, { kinds: ["gate.authorized"] });
    expect(authorized?.source).toBe("engine");
    expect(authorized && parseLedgerPayload(authorized, "gate.authorized")).toEqual({
      questionId: top.id,
      contextVersion,
      becameValidAt: T0 - 120,
      decidedAt: T0 - 100,
      conditions: gateRequest(top.id, contextVersion).conditions,
    });
    // The custom LLM speaks exactly that text for that nonce, as the interviewer only.
    expect(await readTurn(await h.llmTurn(s, granted.controlMessage, "vashistha-tutor-v1"))).toMatchObject({ kind: "skip", reason: "wrong_agent" });
    const second = await h.authorize(s, gateRequest(top.id, contextVersion));
    expect(refusal(second.body)).toBe("question_not_queued");
    const again = GateAuthorizeResponseSchema.parse((await h.authorize(s, gateRequest(queue[1]?.id ?? "", contextVersion))).body);
    expect(await readTurn(await h.llmTurn(s, again.controlMessage))).toMatchObject({ kind: "speech", text: queue[1]?.text });
    const asked = await queueOf(h, s);
    expect(asked.asked.map((a) => a.questionId)).toEqual([top.id, queue[1]?.id]);
    expect(asked.queue.some((q) => q.id === top.id)).toBe(false);
  });

  it("refuses with 409 for every reason, writing nothing", async () => {
    const { h, s } = await expertAfterOneCase();
    const { queue, contextVersion } = await queueOf(h, s);
    const top = queue[0];
    if (!top) throw new Error("empty queue");
    const count = () => h.ledger.list(s).length;
    const before = count();

    const stale = await h.authorize(s, gateRequest(top.id, contextVersion - 1));
    expect([stale.status, refusal(stale.body)]).toEqual([409, "context_changed"]);
    const unknownQ = await h.authorize(s, gateRequest("q_does_not_exist", contextVersion));
    expect([unknownQ.status, refusal(unknownQ.body)]).toEqual([409, "question_not_queued"]);
    expect(count()).toBe(before);

    // Novice session: the tutor may not ask an interviewer's counterfactual (agent_mismatch), but may ask a prediction.
    const novice = await h.session("novice");
    const counterfactual = queueQuestion(h, novice, { id: "q-cf", kind: "counterfactual" });
    const mismatch = await h.authorize(novice, gateRequest(counterfactual.id, h.authorizations.getContextVersion(novice)));
    expect([mismatch.status, refusal(mismatch.body)]).toEqual([409, "agent_mismatch"]);
    const prediction = queueQuestion(h, novice, { id: "q-pred", kind: "prediction" });
    const tutor = await h.authorize(novice, gateRequest(prediction.id, h.authorizations.getContextVersion(novice)));
    expect(tutor.status).toBe(200);
    const tutorGrant = GateAuthorizeResponseSchema.parse(tutor.body);
    expect(await readTurn(await h.llmTurn(novice, tutorGrant.controlMessage, "vashistha-tutor-v1"))).toMatchObject({ kind: "speech", text: prediction.text });

    // Off the record.
    expect((await h.offRecord(s, true)).status).toBe(200);
    const off = await h.authorize(s, gateRequest(top.id, h.authorizations.getContextVersion(s)));
    expect([off.status, refusal(off.body)]).toEqual([409, "off_record"]);

    // Dropped (superseded) questions are no longer queued.
    await h.offRecord(s, false);
    await h.work(s, TWO.id, "approve", "high");
    const dropped = await h.authorize(s, gateRequest(top.id, h.authorizations.getContextVersion(s)));
    expect([dropped.status, refusal(dropped.body)]).toEqual([409, "question_not_queued"]);
  });

  it("rejects malformed requests (400) and unknown sessions (404)", async () => {
    const { h, s } = await expertAfterOneCase();
    const { queue, contextVersion } = await queueOf(h, s);
    const id = queue[0]?.id ?? "";
    expect((await h.authorize(s, { questionId: id })).status).toBe(400);
    expect((await h.authorize(s, { ...gateRequest(id, contextVersion), extra: 1 })).status).toBe(400);
    expect((await h.authorize(s, { ...gateRequest(id, contextVersion), decidedAt: T0 - 500 })).status).toBe(400);
    const missing = await h.authorize("00000000-0000-4000-8000-000000000000", gateRequest(id, contextVersion));
    expect([missing.status, ApiErrorSchema.parse(missing.body).error]).toEqual([404, "session_not_found"]);
  });

  it("a committed decision invalidates an in-flight authorization (nonce refused as context_changed)", async () => {
    const { h, s } = await expertAfterOneCase();
    const { queue, contextVersion } = await queueOf(h, s);
    const granted = GateAuthorizeResponseSchema.parse((await h.authorize(s, gateRequest(queue[0]?.id ?? "", contextVersion))).body);
    await h.work(s, TWO.id, "approve", "high");
    expect(await readTurn(await h.llmTurn(s, granted.controlMessage))).toMatchObject({ kind: "skip", reason: "context_changed" });
  });
});

describe("POST agent-utterances", () => {
  it("records what the agent said under the authorization; refuses control text and unasked questions", async () => {
    const { h, s } = await expertAfterOneCase();
    const { queue, contextVersion } = await queueOf(h, s);
    const top = queue[0];
    if (!top) throw new Error("empty queue");
    const granted = GateAuthorizeResponseSchema.parse((await h.authorize(s, gateRequest(top.id, contextVersion))).body);
    expect((await h.agentSaid(s, { conversationId: "conv-1", text: top.text, questionId: top.id })).status).toBe(204);
    const [said] = h.ledger.list(s, { kinds: ["agent.utterance"] });
    const [authorized] = h.ledger.list(s, { kinds: ["gate.authorized"] });
    expect(said?.source).toBe("engine");
    expect(said?.parentIds).toEqual([authorized?.id]);
    expect((await h.agentSaid(s, { conversationId: "conv-1", text: granted.controlMessage })).status).toBe(400);
    expect((await h.agentSaid(s, { conversationId: "conv-1", text: "x", questionId: queue[1]?.id ?? "q" })).status).toBe(409);
    expect(h.ledger.list(s, { kinds: ["agent.utterance"] })).toHaveLength(1);
  });
});
