/**
 * The coach reacts to what the trainee does: a case opened, a prediction revealed, a selection off the expert's
 * rules, a decision saved, a quiet spell. Each queues exactly one spoken `coach_turn` (with a `tutor.coached`
 * saying why and which rules it teaches from), from the confirmed rulebook only, once per its trigger's scope.
 */
import { describe, expect, it } from "vitest";
import { parseLedgerPayload, type LedgerPayload, type Question } from "@vashistha/core";
import { CoachNudgeResponseSchema } from "../../lib/contracts/tutor";
import { handleCoachNudge } from "../../lib/server/tutor/nudges";
import { handleBriefing } from "../../lib/server/tutor/handlers";
import { jsonRequest } from "../support/casedesk-harness";
import { QUOTES, createTutorHarness, demoRules, type TutorHarness } from "../support/tutor-harness";

const CASE = "NS-2026-0201"; // new company, high-risk country (held-out): enhanced review; approving is a stop-rule

type Coached = LedgerPayload<"tutor.coached"> & { entryId: string; parentIds: string[]; text: string };

async function setup() {
  const h = createTutorHarness();
  const ruleEntries = await h.seedRules(demoRules());
  const sessionId = await h.session();
  return { h, ruleEntries, sessionId };
}

/** The coach's turns so far, with the text each one queued. */
function coached(h: TutorHarness, sessionId: string): Coached[] {
  const texts = new Map(
    h
      .entries(sessionId, ["question.queued"])
      .map((e) => parseLedgerPayload(e, "question.queued"))
      .filter((q) => q.kind === "coach_turn")
      .map((q) => [q.id, q.text]),
  );
  return h.entries(sessionId, ["tutor.coached"]).map((e) => {
    const p = parseLedgerPayload(e, "tutor.coached");
    return { ...p, entryId: e.id, parentIds: e.parentIds, text: texts.get(p.questionId) ?? "" };
  });
}

function coachQuestions(h: TutorHarness, sessionId: string): Question[] {
  return h
    .entries(sessionId, ["question.queued"])
    .map((e) => parseLedgerPayload(e, "question.queued"))
    .filter((q) => q.kind === "coach_turn");
}

const dropped = (h: TutorHarness, sessionId: string) => h.entries(sessionId, ["question.dropped"]).map((e) => parseLedgerPayload(e, "question.dropped"));

/** A judge case the documents rule decides, with no stop-rule firing on it (approve is allowed, just off the rules). */
async function documentsCase(h: TutorHarness, sessionId: string): Promise<{ id: string }> {
  const r = await h.judge(sessionId, {
    entityType: "company",
    customerStatus: "existing",
    accountAgeMonths: 36,
    jurisdictionRisk: "low",
    uboOwnershipPct: 40,
    uboVerified: false,
    pep: false,
    sanctionsHit: false,
    adverseMedia: false,
    sourceOfFunds: "verified",
    expectedMonthlyVolume: 20_000,
  });
  expect(r.status).toBe(201);
  return (r.body as { case: { id: string } }).case;
}

const open = (h: TutorHarness, sessionId: string, caseId: string) => h.events(sessionId, [{ kind: "open_case", caseId }]);

async function speakNext(h: TutorHarness, sessionId: string): Promise<string> {
  const q = await h.questions(sessionId);
  const { queue, contextVersion } = q.body as { queue: { id: string }[]; contextVersion: number };
  const id = queue[0]?.id ?? "";
  expect((await h.authorize(sessionId, id, contextVersion)).status).toBe(200);
  return id;
}

const nudge = (h: TutorHarness, sessionId: string, caseId: string, reason: "idle" | "stuck" = "idle") =>
  handleCoachNudge(jsonRequest(`/api/sessions/${sessionId}/tutor/nudge`, { caseId, reason }), sessionId, h.tutor);

describe("coach: case opened", () => {
  it("asks for a prediction and points at the features the deciding rules read, once per case", async () => {
    const { h, ruleEntries, sessionId } = await setup();
    expect((await open(h, sessionId, CASE)).status).toBe(200);
    const [turn, ...rest] = coached(h, sessionId);
    expect(rest).toEqual([]);
    expect(turn).toMatchObject({ trigger: "case_opened", caseId: CASE, ruleIds: ["rule-enhanced"], origin: "template", utteranceId: null });
    expect(turn?.text).toBe("Before you decide, what do you think the expert would do here? Look at the country risk and the customer status.");
    // Provenance: the open_case event and the rule's own entry.
    const [event] = h.entries(sessionId, ["screen.event"]);
    expect(turn?.parentIds).toEqual([event?.id, ruleEntries.get("rule-enhanced")]);
    // Spoken by the tutor through the queue, below interventions.
    const q = (await h.questions(sessionId)).body as { queue: { id: string; kind: string; target: { caseId?: string } }[] };
    expect(q.queue[0]).toMatchObject({ id: turn?.questionId, kind: "coach_turn", target: { caseId: CASE } });

    await open(h, sessionId, CASE);
    expect(coached(h, sessionId)).toHaveLength(1);
    expect(coachQuestions(h, sessionId)).toHaveLength(1);
  });

  it("says nothing on a decided case", async () => {
    const { h, sessionId } = await setup();
    const docs = await documentsCase(h, sessionId);
    await h.save(sessionId, docs.id, "requestDocuments");
    const before = coached(h, sessionId).length;
    await open(h, sessionId, docs.id);
    expect(coached(h, sessionId).filter((t) => t.trigger === "case_opened")).toHaveLength(0);
    expect(coached(h, sessionId)).toHaveLength(before);
  });

  it("a waiting orientation is dropped once the trainee selects an outcome", async () => {
    const { h, sessionId } = await setup();
    await open(h, sessionId, CASE);
    const [turn] = coached(h, sessionId);
    await h.intent(sessionId, CASE, "enhancedReview");
    expect(dropped(h, sessionId)).toEqual([{ questionId: turn?.questionId, reason: "context_changed" }]);
    expect(coached(h, sessionId)).toHaveLength(1);
  });

  it("lets a waiting welcome briefing go first", async () => {
    const { h, sessionId } = await setup();
    await handleBriefing(jsonRequest(`/api/sessions/${sessionId}/tutor/briefing`, { caseId: CASE }), sessionId, h.tutor);
    await open(h, sessionId, CASE);
    const queue = ((await h.questions(sessionId)).body as { queue: { id: string; kind: string }[] }).queue;
    expect(queue.map((q) => q.kind)).toEqual(["intervention", "coach_turn"]);
    expect(queue[0]?.id).toBe(`briefing-${sessionId}`);
  });
});

describe("coach: prediction reveal", () => {
  it("a wrong prediction is spoken with the expert's rule and words, ending in a question", async () => {
    const { h, sessionId } = await setup();
    expect((await h.predict(sessionId, CASE, "approve")).status).toBe(200);
    const turns = coached(h, sessionId);
    expect(turns).toHaveLength(1);
    const [prediction] = h.entries(sessionId, ["tutor.prediction"]);
    expect(turns[0]).toMatchObject({ trigger: "prediction", caseId: CASE, ruleIds: ["rule-enhanced"] });
    expect(turns[0]?.parentIds[0]).toBe(prediction?.id);
    expect(turns[0]?.text).toBe(
      `Not quite. The expert would send to enhanced review here, because country risk is high and customer status is new. In their words: "${QUOTES.enhanced}" What in this case points to that?`,
    );
  });

  it("a right prediction gets brief praise and the reason", async () => {
    const { h, sessionId } = await setup();
    await h.predict(sessionId, CASE, "enhancedReview");
    const [turn] = coached(h, sessionId);
    expect(turn?.text).toMatch(/^Right! The expert would also send to enhanced review here, because country risk is high and customer status is new\./);
    expect(turn?.text).toMatch(/Go ahead and make your decision\.$/);
  });
});

describe("coach: off track", () => {
  it("a selection the rules disagree with (no stop-rule) gets one nudge citing the rule and the facts, once per selection", async () => {
    const { h, sessionId } = await setup();
    const docs = await documentsCase(h, sessionId);
    const r = await h.intent(sessionId, docs.id, "approve");
    expect(r.status).toBe(200);
    expect((r.body as { intervention: unknown }).intervention).toBeNull();
    const [turn, ...rest] = coached(h, sessionId);
    expect(rest).toEqual([]);
    const [intent] = h.entries(sessionId, ["tutor.intent"]);
    expect(turn).toMatchObject({ trigger: "off_track", caseId: docs.id, ruleIds: ["rule-documents"] });
    expect(turn?.parentIds[0]).toBe(intent?.id);
    expect(turn?.text).toMatch(/^You picked approve onboarding, but this case has the largest beneficial owner share is 40% and the largest owner identity verified is no\./);
    expect(turn?.text).toMatch(/Want to look again\?$/);
    expect(turn?.text.split(/\s+/).length).toBeLessThanOrEqual(55);

    await h.intent(sessionId, docs.id, "approve");
    expect(coached(h, sessionId)).toHaveLength(1);
  });

  it("reselecting the expected outcome drops the waiting nudge (nothing said: it was never heard)", async () => {
    const { h, sessionId } = await setup();
    const docs = await documentsCase(h, sessionId);
    await h.intent(sessionId, docs.id, "approve");
    const [turn] = coached(h, sessionId);
    await h.intent(sessionId, docs.id, "requestDocuments");
    expect(dropped(h, sessionId)).toEqual([{ questionId: turn?.questionId, reason: "context_changed" }]);
    expect(coached(h, sessionId)).toHaveLength(1);
    expect(((await h.questions(sessionId)).body as { queue: unknown[] }).queue).toEqual([]);
  });

  it("after a spoken nudge, switching to the expected outcome gets a short 'That's it'", async () => {
    const { h, sessionId } = await setup();
    const docs = await documentsCase(h, sessionId);
    await h.intent(sessionId, docs.id, "approve");
    await speakNext(h, sessionId);
    await h.intent(sessionId, docs.id, "requestDocuments");
    const turns = coached(h, sessionId);
    expect(turns).toHaveLength(2);
    expect(turns[1]).toMatchObject({ trigger: "off_track", caseId: docs.id, ruleIds: ["rule-documents"] });
    expect(turns[1]?.text).toBe("That's it: request documents is what the expert would do here. Save it when you're ready.");
    await h.intent(sessionId, docs.id, "requestDocuments");
    expect(coached(h, sessionId)).toHaveLength(2);
  });

  it("never duplicates a stop-rule intervention, and a waiting nudge is dropped when the selection moves to one", async () => {
    const { h, sessionId } = await setup();
    await h.intent(sessionId, CASE, "reject"); // off the rules, no stop-rule
    const [nudgeTurn] = coached(h, sessionId);
    expect(nudgeTurn).toMatchObject({ trigger: "off_track", ruleIds: ["rule-enhanced"] });
    const r = await h.intent(sessionId, CASE, "approve"); // a stop-rule: the monitor intervenes
    expect((r.body as { fresh: boolean }).fresh).toBe(true);
    expect(coached(h, sessionId)).toHaveLength(1);
    expect(dropped(h, sessionId)).toContainEqual({ questionId: nudgeTurn?.questionId, reason: "context_changed" });
    const queue = ((await h.questions(sessionId)).body as { queue: { kind: string }[] }).queue;
    expect(queue.map((q) => q.kind)).toEqual(["intervention"]);
  });

  it("a selection the rules agree with, with no warning before, says nothing", async () => {
    const { h, sessionId } = await setup();
    await h.intent(sessionId, CASE, "enhancedReview");
    expect(coached(h, sessionId)).toEqual([]);
  });
});

describe("coach: decision saved", () => {
  it("a correct decision gets praise, the rung it moved up, and the next case", async () => {
    const { h, sessionId } = await setup();
    const docs = await documentsCase(h, sessionId);
    const { commit } = await h.save(sessionId, docs.id, "requestDocuments");
    expect(commit.status).toBe(200);
    const turns = coached(h, sessionId);
    expect(turns).toHaveLength(1);
    const [decision] = h.entries(sessionId, ["case.decision"]);
    const moved = h.entries(sessionId, ["mastery.updated"]);
    expect(turns[0]).toMatchObject({ trigger: "committed", caseId: docs.id, ruleIds: ["rule-documents"] });
    expect(turns[0]?.parentIds.slice(0, 1 + moved.length)).toEqual([decision?.id, ...moved.map((m) => m.id)]);
    expect(turns[0]?.text).toMatch(
      /^Well done: request documents is what the expert would do here\. You are now at "independently correct once" on the rule to request documents\. Next, open case NS-2026-\d{4}\.$/,
    );
  });

  it("an incorrect decision the interlock allows gets what the expert would have done and why", async () => {
    const { h, sessionId } = await setup();
    const docs = await documentsCase(h, sessionId);
    await h.intent(sessionId, docs.id, "approve");
    const [offTrack] = coached(h, sessionId);
    const { commit } = await h.save(sessionId, docs.id, "approve");
    expect(commit.status).toBe(200);
    const turns = coached(h, sessionId);
    expect(turns).toHaveLength(2);
    // The unspoken nudge about this case is gone once the case is saved.
    expect(dropped(h, sessionId).map((d) => d.questionId)).toContain(offTrack?.questionId);
    expect(turns[1]).toMatchObject({ trigger: "committed", caseId: docs.id, ruleIds: ["rule-documents"] });
    expect(turns[1]?.text).toMatch(/^Saved\. The expert would request documents here instead, because largest beneficial owner share above 25% and largest owner identity verified is no\./);
    expect(turns[1]?.text).toContain(`"${QUOTES.documents}"`);
    expect(turns[1]?.text).toMatch(/Next, open case NS-2026-\d{4}\.$/);
  });

  it("suggests a practice case on the weakest rule first", async () => {
    const { h, sessionId } = await setup();
    const p = await h.practice(sessionId);
    expect(p.status).toBe(201);
    const made = (p.body as { cases: { id: string }[] }).cases.map((c) => c.id);
    await h.save(sessionId, CASE, "enhancedReview");
    const [turn] = coached(h, sessionId).filter((t) => t.trigger === "committed");
    const next = /Next, open case (NS-2026-\d{4}): it practises the rule you find hardest\.$/.exec(turn?.text ?? "");
    expect(next?.[1]).toBeDefined();
    expect(made).toContain(next?.[1]);
  });
});

describe("coach: idle and stuck hints", () => {
  it("POST …/tutor/nudge queues one hint per case per reason; stuck names the rule in the expert's words", async () => {
    const { h, sessionId } = await setup();
    const idle = CoachNudgeResponseSchema.parse(await (await nudge(h, sessionId, CASE)).json());
    expect(idle).toMatchObject({ queued: true, text: "Need a hint? Check the country risk and the customer status. What would the expert do with that?" });
    expect(CoachNudgeResponseSchema.parse(await (await nudge(h, sessionId, CASE)).json())).toEqual({ queued: false, reason: "already_given" });
    const stuck = CoachNudgeResponseSchema.parse(await (await nudge(h, sessionId, CASE, "stuck")).json());
    expect(stuck.queued && stuck.text).toBe(
      `Here's the expert's rule: when country risk is high and customer status is new, send to enhanced review. In their words: "${QUOTES.enhanced}" Does it apply here?`,
    );
    const turns = coached(h, sessionId);
    expect(turns.map((t) => t.trigger)).toEqual(["idle", "stuck"]);
    expect(turns.map((t) => t.questionId)).toEqual([idle.queued ? idle.questionId : "", stuck.queued ? stuck.questionId : ""]);
    // Only the newest unspoken coach turn waits.
    expect(((await h.questions(sessionId)).body as { queue: { id: string }[] }).queue.map((q) => q.id)).toEqual([turns[1]?.questionId]);
  });

  it("an idle trainee whose selection matches is told to save", async () => {
    const { h, sessionId } = await setup();
    await h.intent(sessionId, CASE, "enhancedReview");
    const r = CoachNudgeResponseSchema.parse(await (await nudge(h, sessionId, CASE)).json());
    expect(r).toMatchObject({ queued: true, text: "Your choice matches the expert's rules. Save it when you're ready." });
  });

  it("no hint on a decided case, on an unknown case, or off the record", async () => {
    const { h, sessionId } = await setup();
    const docs = await documentsCase(h, sessionId);
    await h.save(sessionId, docs.id, "requestDocuments");
    expect(CoachNudgeResponseSchema.parse(await (await nudge(h, sessionId, docs.id)).json())).toEqual({ queued: false, reason: "decided" });
    expect((await nudge(h, sessionId, "NS-2026-9999")).status).toBe(400);

    const before = coached(h, sessionId).length;
    await h.offRecord(sessionId, true);
    const off = await nudge(h, sessionId, CASE);
    expect(off.status).toBe(409);
    expect(coached(h, sessionId)).toHaveLength(before);
  });
});

describe("coach: off the record", () => {
  it("nothing is coached while off the record (the trainee's writes are refused, and so is every nudge)", async () => {
    const { h, sessionId } = await setup();
    await h.offRecord(sessionId, true);
    expect((await open(h, sessionId, CASE)).status).toBe(409);
    expect((await h.intent(sessionId, CASE, "reject")).status).toBe(409);
    expect((await h.predict(sessionId, CASE, "approve")).status).toBe(409);
    expect((await nudge(h, sessionId, CASE)).status).toBe(409);
    await h.offRecord(sessionId, false);
    expect(h.entries(sessionId, ["tutor.coached"])).toEqual([]);
    expect(coachQuestions(h, sessionId)).toEqual([]);
  });
});
