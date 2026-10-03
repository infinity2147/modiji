/** P6 guardrail monitor: stop-rule violations sensed before Save become ledgered, spoken interventions. */
import { describe, expect, it } from "vitest";
import { ActionIdSchema, parseLedgerPayload, unknown, type FeatureLookup } from "@vashistha/core";
import { caseFeatures, findKycCase } from "@vashistha/core/domains/kyc";
import { TutorIntentResponseSchema } from "../../lib/contracts/tutor";
import { evaluateSelection } from "../../lib/server/tutor/monitor";
import { MAX_INTERVENTION_WORDS, interventionText } from "../../lib/server/tutor/rules";
import { QUOTES, createTutorHarness, demoRules, expertRule } from "../support/tutor-harness";

const CASE = "NS-2026-0201"; // new company, high-risk country (held-out)

async function setup() {
  const h = createTutorHarness();
  const ruleEntries = await h.seedRules(demoRules());
  const sessionId = await h.session();
  return { h, ruleEntries, sessionId };
}

describe("guardrail monitor", () => {
  it("a forbidden selection records an intervention (parent: the intent and the rule) and queues an ephemeral intervention question", async () => {
    const { h, ruleEntries, sessionId } = await setup();
    const r = await h.intent(sessionId, CASE, "approve");
    expect(r.status).toBe(200);
    const body = TutorIntentResponseSchema.parse(r.body);
    expect(body.result.decision).toBe("forbid");
    expect(body.fresh).toBe(true);
    expect(body.intervention).toMatchObject({ caseId: CASE, trigger: "guardrail_violation", proposedAction: "approve", ruleIds: ["rule-never-approve"], speech: "queued" });
    // Spoken text: the rule in plain words and the expert's exact quote, short enough to say before Save.
    expect(body.intervention?.text).toContain(`"${QUOTES.neverApprove}"`);
    expect(body.intervention?.text.startsWith("Careful — never approve onboarding when")).toBe(true);
    expect(body.intervention?.text.split(/\s+/).length).toBeLessThanOrEqual(MAX_INTERVENTION_WORDS);

    const [intent] = h.entries(sessionId, ["tutor.intent"]);
    const [intervention] = h.entries(sessionId, ["tutor.intervention"]);
    const [queued] = h.entries(sessionId, ["question.queued"]);
    expect(intent?.source).toBe("dom");
    expect(intervention?.source).toBe("engine");
    expect(intervention?.parentIds).toEqual([intent?.id, ruleEntries.get("rule-never-approve")]);
    const question = parseLedgerPayload(queued ?? intent!, "question.queued");
    expect(question).toMatchObject({ kind: "intervention", ephemeral: true, text: body.intervention?.text, target: { caseId: CASE, ruleId: "rule-never-approve" } });
    expect(queued?.parentIds).toEqual([intervention?.id]);
    expect(question.id).toBe(body.intervention?.questionId);

    // The tutor agent may speak it now: the queue offers it and the gate route authorizes it in a novice session.
    const q = await h.questions(sessionId);
    const queue = (q.body as { queue: { id: string; kind: string }[]; contextVersion: number }).queue;
    expect(queue[0]).toMatchObject({ id: question.id, kind: "intervention" });
    const auth = await h.authorize(sessionId, question.id, (q.body as { contextVersion: number }).contextVersion);
    expect(auth.status).toBe(200);
    expect((auth.body as { text: string }).text).toBe(body.intervention?.text);
    const after = TutorIntentResponseSchema.parse((await h.intent(sessionId, CASE, "approve")).body);
    expect(after.intervention?.speech).toBe("spoken");
  });

  it("the intervention precedes Save in the ledger, and Save is then blocked by the interlock", async () => {
    const { h, sessionId } = await setup();
    await h.intent(sessionId, CASE, "approve");
    const { check, commit } = await h.save(sessionId, CASE, "approve");
    expect((check.body as { result: { decision: string } }).result.decision).toBe("forbid");
    expect(commit.status).toBe(409);
    expect(commit.body).toMatchObject({ status: "blocked" });
    const seq = (kind: string) => h.entries(sessionId, [kind]).map((e) => e.sequence);
    expect(Math.max(...seq("tutor.intervention"))).toBeLessThan(Math.min(...seq("interlock.check")));
    expect(seq("case.decision")).toEqual([]);
  });

  it("dedupes per (case, action, rule); a changed outcome drops the unspoken warning; reselecting does not re-warn", async () => {
    const { h, sessionId } = await setup();
    const first = TutorIntentResponseSchema.parse((await h.intent(sessionId, CASE, "approve")).body);
    const again = TutorIntentResponseSchema.parse((await h.intent(sessionId, CASE, "approve", { riskRating: "high" })).body);
    expect(again.fresh).toBe(false);
    expect(again.intervention?.entryId).toBe(first.intervention?.entryId);

    const switched = TutorIntentResponseSchema.parse((await h.intent(sessionId, CASE, "enhancedReview")).body);
    expect(switched.result.decision).toBe("allow");
    expect(switched.intervention).toBeNull();
    const [dropped] = h.entries(sessionId, ["question.dropped"]);
    expect(parseLedgerPayload(dropped!, "question.dropped")).toEqual({ questionId: first.intervention?.questionId, reason: "context_changed" });

    const back = TutorIntentResponseSchema.parse((await h.intent(sessionId, CASE, "approve")).body);
    expect(back).toMatchObject({ fresh: false, intervention: { entryId: first.intervention?.entryId, speech: "dropped" } });
    expect(h.entries(sessionId, ["tutor.intervention"])).toHaveLength(1);
    // The queue no longer offers the withdrawn warning.
    expect((await h.questions(sessionId)).body).toMatchObject({ queue: [] });
  });

  it("a field change (DOM channel) re-runs the monitor on the selected outcome", async () => {
    const h = createTutorHarness();
    // A stop-rule on the reviewer-editable rating.
    await h.seedRules([
      expertRule({ id: "rule-rated-high", kind: "guardrail", effect: { type: "forbid", action: "approve" }, predicate: { "==": [{ var: "riskRating" }, "high"] }, quote: "Anything we rate high is never approved." }),
    ]);
    const sessionId = await h.session("training");
    const caseId = "NS-2026-0103";
    const quiet = TutorIntentResponseSchema.parse((await h.intent(sessionId, caseId, "approve")).body);
    expect(quiet.intervention).toBeNull();
    const posted = await h.events(sessionId, [{ kind: "field_change", caseId, field: "riskRating", from: "unrated", to: "high" }]);
    expect(posted.status).toBe(200);
    const [event] = h.entries(sessionId, ["screen.event"]);
    const [intervention] = h.entries(sessionId, ["tutor.intervention"]);
    expect(intervention?.parentIds[0]).toBe(event?.id);
    expect(parseLedgerPayload(intervention!, "tutor.intervention")).toMatchObject({ caseId, proposedAction: "approve", ruleIds: ["rule-rated-high"] });
  });

  it("insufficient information on a stop-rule is an intervention that names what to check", () => {
    const rules = demoRules();
    const known = caseFeatures(findKycCase(CASE)!);
    const lookup: FeatureLookup = (id) => (id === "jurisdictionRisk" ? unknown("not_extracted") : (known[id] ?? unknown("not_extracted")));
    const approve = ActionIdSchema.parse("approve");
    const selection = evaluateSelection(rules, lookup, approve);
    expect(selection.result.decision).toBe("insufficient_information");
    expect(selection.result.missingFeatures).toEqual(["jurisdictionRisk"]);
    expect(selection.trigger).toBe("insufficient_information");
    expect(selection.stopRules.map((r) => r.id)).toEqual(["rule-never-approve"]);
    const [rule] = selection.stopRules;
    if (rule === undefined) throw new Error("no stop-rule");
    const text = interventionText({ rule, trigger: "insufficient_information", proposedAction: approve, missingFeatures: selection.result.missingFeatures });
    expect(text).toContain("check country risk");
    expect(text).toContain(QUOTES.neverApprove);
  });

  it("approval-only results and allowed selections never intervene", async () => {
    const { h, sessionId } = await setup();
    const allowed = TutorIntentResponseSchema.parse((await h.intent(sessionId, CASE, "enhancedReview")).body);
    expect(allowed).toMatchObject({ fresh: false, intervention: null, result: { decision: "allow" } });
    expect(h.entries(sessionId, ["tutor.intervention", "question.queued"])).toEqual([]);
  });

  it("off the record: the selection is refused and nothing is recorded", async () => {
    const { h, sessionId } = await setup();
    await h.offRecord(sessionId, true);
    const r = await h.intent(sessionId, CASE, "approve");
    expect(r.status).toBe(409);
    expect(r.body).toMatchObject({ error: "off_record" });
    expect(h.entries(sessionId, ["tutor.intent", "tutor.intervention", "question.queued"])).toEqual([]);
  });

  it("expert sessions have no tutor", async () => {
    const { h } = await setup();
    const expert = await h.session("training", "expert");
    expect((await h.intent(expert, "NS-2026-0101", "approve")).status).toBe(409);
    expect((await h.state(expert)).body).toMatchObject({ error: "not_novice" });
  });
});
