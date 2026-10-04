/**
 * The live queue planner supersedes only what it plans (plan §7.2–7.3): after each committed decision
 * the interview requeue drops live-interview questions it did not re-plan, and never touches debrief
 * (`witness`, `teach_back`) or tutor (`prediction`, `intervention`) questions.
 */
import { describe, expect, it } from "vitest";
import { LIVE_QUESTION_KINDS, QuestionSchema, parseLedgerPayload, type QuestionKind } from "@vashistha/core";
import { engineState } from "../../lib/server/interview/engine-state";
import { createInterviewHarness, trainingCases } from "../support/interview-harness";

const [ONE, TWO] = trainingCases();
const OTHER_FLOWS: QuestionKind[] = ["witness", "teach_back", "prediction", "intervention"];

describe("interview requeue", () => {
  it("drops its own superseded live questions but keeps debrief and tutor questions queued", async () => {
    const h = createInterviewHarness();
    const s = await h.session("expert");
    await h.work(s, ONE.id, "enhancedReview", "medium");
    const firstLive = [...engineState(h.deps, s).questions.values()].filter((r) => r.status === "queued");
    expect(firstLive.length).toBeGreaterThan(0);
    expect(firstLive.every((r) => (LIVE_QUESTION_KINDS as readonly string[]).includes(r.question.kind))).toBe(true);

    // Another flow's questions, queued as the debrief and the tutor write them.
    const others = OTHER_FLOWS.map((kind) =>
      h.ledger.append({
        sessionId: s,
        source: "engine",
        kind: "question.queued",
        occurredAt: 1,
        traceId: `trace-${kind}`,
        parentIds: [],
        schemaVersion: 1,
        privacyEpoch: h.epoch(s),
        payload: QuestionSchema.parse({
          id: `q-${kind}`,
          sessionId: s,
          kind,
          text: `A ${kind} question.`,
          decisionFamily: "reviewOutcome",
          target: { candidateIds: [] },
          value: 1,
          reason: `${kind} flow`,
          ephemeral: kind === "intervention",
          createdAt: 1,
          contextVersion: 0,
          parentIds: [],
        }),
      }),
    );

    await h.work(s, TWO.id, "approve");
    const state = engineState(h.deps, s);
    for (const kind of OTHER_FLOWS) expect(state.questions.get(`q-${kind}`)?.status, kind).toBe("queued");
    const dropped = h.ledger.list(s, { kinds: ["question.dropped"] }).map((e) => parseLedgerPayload(e, "question.dropped").questionId);
    expect(dropped.filter((id) => others.some((o) => parseLedgerPayload(o, "question.queued").id === id))).toEqual([]);
    // The live questions about case 1 were not re-planned for case 2: superseded.
    for (const r of firstLive) expect(state.questions.get(r.question.id)?.status).toBe("dropped");
    expect(dropped).toEqual(expect.arrayContaining(firstLive.map((r) => r.question.id)));
  });
});
