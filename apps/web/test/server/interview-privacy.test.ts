/** Off the record (plan §7.8): epoch and context bump, in-flight nonce refused, nothing captured while off. */
import { describe, expect, it } from "vitest";
import { ApiErrorSchema } from "../../lib/contracts/casedesk";
import { GateAuthorizeResponseSchema, OffRecordResponseSchema, QuestionQueueResponseSchema } from "../../lib/contracts/interview";
import { createInterviewHarness, gateRequest, utterance, trainingCases } from "../support/interview-harness";
import { readTurn } from "../support/llm-harness";

const [ONE] = trainingCases();

describe("POST off-record", () => {
  it("advances epoch and context version, refuses the in-flight nonce and all capture, then resumes on a new epoch", async () => {
    const h = createInterviewHarness();
    const s = await h.session("expert");
    await h.work(s, ONE.id, "enhancedReview", "medium");
    const { queue, contextVersion } = QuestionQueueResponseSchema.parse((await h.questions(s)).body);
    const top = queue[0];
    if (!top) throw new Error("empty queue");
    const granted = GateAuthorizeResponseSchema.parse((await h.authorize(s, gateRequest(top.id, contextVersion))).body);

    const off = await h.offRecord(s, true);
    expect(off.status).toBe(200);
    expect(OffRecordResponseSchema.parse(off.body)).toEqual({ offRecord: true, privacyEpoch: 1, contextVersion: contextVersion + 1 });
    // Idempotent: asking again changes nothing.
    expect(OffRecordResponseSchema.parse((await h.offRecord(s, true)).body)).toEqual({ offRecord: true, privacyEpoch: 1, contextVersion: contextVersion + 1 });

    // The gate's in-flight authorization is refused by the nonce store; nothing new is authorised.
    expect(await readTurn(await h.llmTurn(s, granted.controlMessage))).toMatchObject({ kind: "skip", reason: "context_changed" });
    const refused = await h.authorize(s, gateRequest(queue[1]?.id ?? top.id, contextVersion + 1));
    expect([refused.status, ApiErrorSchema.parse(refused.body).error]).toEqual([409, "off_record"]);
    expect(QuestionQueueResponseSchema.parse((await h.questions(s)).body).offRecord).toBe(true);

    // Nothing captured enters the store while off the record.
    const capturedBefore = h.ledger.list(s, { sources: ["voice", "client", "dom"] }).length;
    for (const epoch of [0, 1]) {
      const r = await h.utter(s, utterance(h, s, "This bit is off the record.", { privacyEpoch: epoch }));
      expect([r.status, ApiErrorSchema.parse(r.body).error]).toEqual([409, "off_record"]);
    }
    expect((await h.agentSaid(s, { conversationId: "conv-1", text: "Understood." })).status).toBe(409);
    expect(() => h.frame(s)).toThrow(/off the record/);
    expect(h.ledger.list(s, { sources: ["voice", "client", "dom"] })).toHaveLength(capturedBefore);
    expect(h.ledger.list(s, { kinds: ["utterance.transcript", "agent.utterance", "frame.received"] })).toEqual([]);

    // Resume: a new epoch; capture stamped with an old epoch stays refused.
    const on = OffRecordResponseSchema.parse((await h.offRecord(s, false)).body);
    expect(on).toEqual({ offRecord: false, privacyEpoch: 2, contextVersion: contextVersion + 2 });
    const stale = await h.utter(s, utterance(h, s, "Back on.", { privacyEpoch: 1 }));
    expect([stale.status, ApiErrorSchema.parse(stale.body).error]).toEqual([409, "stale_epoch"]);
    expect((await h.utter(s, utterance(h, s, "Back on."))).status).toBe(200);
    expect(h.ledger.list(s, { kinds: ["privacy.off_record", "privacy.on_record"] }).map((e) => [e.kind, e.source])).toEqual([
      ["privacy.off_record", "system_control"],
      ["privacy.on_record", "system_control"],
    ]);
  });
});
