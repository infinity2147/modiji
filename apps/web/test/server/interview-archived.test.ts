/**
 * Archived sessions vs the voice loop: engine work that outlives the archive — an authorization that
 * lapses afterwards, an answer window that closes afterwards, a parse in flight when the archive lands —
 * is skipped instead of appending (which the ledger refuses with `session_archived`), and
 * `GET /questions` on an archived session answers 200 with an empty queue.
 */
import { describe, expect, it } from "vitest";
import type { LlmAnswer } from "@vashistha/core";
import { GateAuthorizeResponseSchema, QuestionQueueResponseSchema } from "../../lib/contracts/interview";
import { handleArchiveSession } from "../../lib/server/casedesk/archive";
import { ANSWER_WINDOW_IDLE_MS } from "../../lib/server/interview/orchestrator";
import { createInterviewHarness, gateRequest, utterance, trainingCases, type InterviewHarness } from "../support/interview-harness";
import { readTurn } from "../support/llm-harness";

const [ONE] = trainingCases();
const ARCHIVE_SECRET = "archive-secret-0123456789-abcdefghij";
const STOP = "Never approve a politically exposed person without compliance sign-off.";

const ANSWER: LlmAnswer = {
  survivingCandidateIds: [],
  eliminatedCandidateIds: [],
  statedRules: [
    {
      when: { combinator: "all", conditions: [{ feature: "pep", op: "==", value: true }] },
      polarity: "require_approval",
      action: "approve",
      approvalRole: "compliance_officer",
      kind: "guardrail",
      exactQuote: STOP,
    },
  ],
  newConcepts: [],
  answeredAction: null,
  confidence: 0.9,
};

/** The operator archive route, on the harness's ledger and nonce store. */
async function archive(h: InterviewHarness, sessionId: string): Promise<void> {
  const response = await handleArchiveSession(
    new Request(`http://localhost/api/sessions/${sessionId}/archive`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${ARCHIVE_SECRET}` },
      body: JSON.stringify({ by: "operator" }),
    }),
    sessionId,
    { ledger: h.ledger, store: h.deps.casedesk, authorizations: h.authorizations, secret: ARCHIVE_SECRET, now: h.deps.now, log: h.deps.log },
  );
  expect(response.status).toBe(200);
}

async function queueOf(h: InterviewHarness, s: string) {
  const r = await h.questions(s);
  expect(r.status, JSON.stringify(r.body)).toBe(200);
  return QuestionQueueResponseSchema.parse(r.body);
}

/** An expert session after case 1, its first queued question authorized (not yet spoken). */
async function authorizedSession(h: InterviewHarness) {
  const s = await h.session("expert");
  await h.work(s, ONE.id, "enhancedReview", "medium");
  const { queue, contextVersion } = await queueOf(h, s);
  const top = queue[0];
  if (top === undefined) throw new Error("empty queue");
  const granted = GateAuthorizeResponseSchema.parse((await h.authorize(s, gateRequest(top.id, contextVersion))).body);
  return { s, top, granted };
}

/** An expert session whose why-probe was asked and spoken; the expert's answer segment is open. */
async function openAnswer(h: InterviewHarness) {
  const { s, top, granted } = await authorizedSession(h);
  expect(await readTurn(await h.llmTurn(s, granted.controlMessage))).toMatchObject({ kind: "speech", text: top.text });
  h.frame(s);
  const r = await h.utter(s, utterance(h, s, STOP, { questionId: top.id, t0Ms: 10_000, t1Ms: 13_000 }));
  expect(r.status, JSON.stringify(r.body)).toBe(200);
  return { s, question: top };
}

/** No step tried (and failed) to write to the archived session. */
function expectNoRefusedWrites(h: InterviewHarness): void {
  expect(h.logs.filter((l) => l.includes("read-only") || l.includes("failed"))).toEqual([]);
}

describe("archived sessions in the voice loop", () => {
  it("a lapsed authorization of an archived session is not re-queued; its GET /questions answers 200 with an empty queue", async () => {
    const h = createInterviewHarness();
    const archived = await authorizedSession(h);
    const live = await authorizedSession(h);
    await archive(h, archived.s);
    const entries = h.ledger.list(archived.s).length;

    h.advance(4000); // both authorizations lapse unspoken
    const read = await queueOf(h, archived.s);
    expect(read.queue).toEqual([]);
    expect(read.asked.map((a) => a.questionId)).toEqual([archived.top.id]);
    expect(h.ledger.list(archived.s)).toHaveLength(entries);
    expect(h.logs.some((l) => l.includes(`session ${archived.s} is archived; re-queueing ${archived.top.id}`))).toBe(true);

    // The same sweep re-queued the live session's question.
    expect(h.ledger.list(live.s, { kinds: ["question.requeued"] })).toHaveLength(1);
    expect((await queueOf(h, live.s)).queue.some((q) => q.id === live.top.id)).toBe(true);
    expect((await queueOf(h, archived.s)).queue).toEqual([]);
    expectNoRefusedWrites(h);
  });

  it("an answer window that closes after the archive is not parsed (no model call, nothing appended)", async () => {
    const h = createInterviewHarness();
    h.setModel({ answer: () => ANSWER });
    const { s, question } = await openAnswer(h);
    await archive(h, s);
    const entries = h.ledger.list(s).length;

    h.advance(ANSWER_WINDOW_IDLE_MS);
    await h.idle(s);
    expect(h.ledger.list(s)).toHaveLength(entries);
    expect(h.modelCalls.filter((c) => c.kind === "answer")).toEqual([]);
    expect(h.logs.some((l) => l.includes(`session ${s} is archived; parsing answer`) && l.includes(question.id))).toBe(true);
    expectNoRefusedWrites(h);
  });

  it("an archive landing while the answer is being parsed: the parse is dropped, nothing is appended", async () => {
    const h = createInterviewHarness();
    const parsing: { session?: string } = {};
    h.setModel({
      answer: () => {
        if (parsing.session === undefined) throw new Error("no session yet");
        h.ledger.archive(parsing.session, { occurredAt: h.deps.now(), traceId: "trace-archive", by: "operator" });
        return ANSWER;
      },
    });
    const { s } = await openAnswer(h);
    parsing.session = s;
    await h.closeAnswer(s);

    // The archive is the session's last entry: nothing of the parse was appended after it.
    expect(h.ledger.list(s).at(-1)?.kind).toBe("session.archived");
    expect(h.modelCalls.filter((c) => c.kind === "answer")).toHaveLength(1);
    expect(h.logs.some((l) => l.includes(`session ${s} is archived; recording the parse of answer`))).toBe(true);
    expectNoRefusedWrites(h);
  });
});
