/** P6 client: the review panel's predict-then-reveal state machine, the intervention and reveal cards, the tutor API client. */
import { describe, expect, it } from "vitest";
import { ActionIdSchema } from "@vashistha/core";
import type { CaseTutorView, InterventionView, PredictionView, TutorRule, TutorState } from "../../lib/contracts/tutor";
import { listCases } from "../../lib/client/api";
import { postIntent } from "../../lib/client/tutor/api";
import { INITIAL_PREDICT_STATE, decisionUnlocked, predictReducer, type PredictEvent, type PredictState } from "../../lib/client/tutor/predict-machine";
import { activeIntervention, interventionCard, ladder, revealCard } from "../../lib/client/tutor/view";
import { jsonResponse, scriptedFetch } from "./fake-fetch";

const approve = ActionIdSchema.parse("approve");
const enhanced = ActionIdSchema.parse("enhancedReview");
const QUOTE = "Never approve a new customer from a high-risk country on the spot.";

const rule: TutorRule = {
  ruleId: "rule-never-approve",
  kind: "guardrail",
  when: "country risk is high and customer status is new",
  then: "never approve onboarding",
  stopRule: true,
  quote: {
    text: QUOTE,
    attribution: "The expert, by voice",
    replay: { frameUrl: null, frameNote: "Frame unavailable: no screen moment of this quote is on record.", screen: [], audioNote: "Audio playback unavailable." },
  },
  level: "untested",
};
const decisionRule: TutorRule = { ...rule, ruleId: "rule-enhanced", kind: "decision", then: "send to enhanced review", stopRule: false };

const intervention: InterventionView = {
  entryId: "e-1",
  caseId: "NS-2026-0201",
  trigger: "guardrail_violation",
  proposedAction: approve,
  ruleIds: ["rule-never-approve"],
  questionId: "q-1",
  text: `Careful — never approve onboarding when country risk is high and customer status is new. The expert said: "${QUOTE}"`,
  speech: "queued",
};
const prediction: PredictionView = { entryId: "p-1", predicted: approve, expected: enhanced, correct: false, ruleIds: ["rule-enhanced"] };

function view(over: Partial<CaseTutorView> = {}): CaseTutorView {
  return { caseId: "NS-2026-0201", origin: "case_set", prompt: { ask: true }, prediction: null, interventions: [], ...over };
}

const state: TutorState = { sessionId: "s-1", rulebookRevision: 2, masteryLabel: "heuristic estimate", rules: [decisionRule, rule], cases: [view()], coach: [] };

function run(events: readonly PredictEvent[], from: PredictState = INITIAL_PREDICT_STATE): PredictState {
  return events.reduce(predictReducer, from);
}

describe("predict-then-reveal state machine", () => {
  it("asks first; the decision form stays locked until the prediction is revealed", () => {
    let s = run([{ type: "view", view: view() }]);
    expect(s).toEqual({ phase: "ask", choice: undefined, submitting: false, error: undefined });
    expect(decisionUnlocked(s)).toBe(false);
    s = run([{ type: "submit" }], s);
    expect(s).toMatchObject({ phase: "ask", submitting: false }); // nothing chosen yet
    s = run([{ type: "choose", action: approve }, { type: "submit" }], s);
    expect(s).toMatchObject({ phase: "ask", choice: approve, submitting: true });
    expect(run([{ type: "choose", action: enhanced }], s)).toBe(s); // locked while submitting
    s = run([{ type: "submitted", prediction }], s);
    expect(s).toEqual({ phase: "revealed", prediction });
    expect(decisionUnlocked(s)).toBe(true);
    // A refresh racing the reveal never re-asks.
    expect(run([{ type: "view", view: view() }], s)).toBe(s);
  });

  it("a failed submission keeps the choice and shows the error; retry works", () => {
    const s = run([{ type: "view", view: view() }, { type: "choose", action: approve }, { type: "submit" }, { type: "failed", message: "Request refused (409 off_record)" }]);
    expect(s).toEqual({ phase: "ask", choice: approve, submitting: false, error: "Request refused (409 off_record)" });
    expect(run([{ type: "submit" }], s)).toMatchObject({ submitting: true, error: undefined });
  });

  it("skips with the server's reason when not to ask; resumes a recorded prediction as revealed", () => {
    const skip = run([{ type: "view", view: view({ prompt: { ask: false, reason: "The expert's confirmed rules do not decide this case yet." } }) }]);
    expect(skip).toEqual({ phase: "skip", reason: "The expert's confirmed rules do not decide this case yet." });
    expect(decisionUnlocked(skip)).toBe(true);
    expect(run([{ type: "view", view: view({ prompt: { ask: false, reason: "Prediction made." }, prediction }) }])).toEqual({ phase: "revealed", prediction });
    expect(run([{ type: "view", view: undefined }])).toEqual(INITIAL_PREDICT_STATE);
  });
});

describe("tutor cards", () => {
  it("the intervention card shows the warning, exactly what the tutor speaks, its speech status and the expert's words", () => {
    const card = interventionCard(state, intervention);
    expect(card.headline).toBe("Careful — the expert's rule forbids “Approve onboarding” here");
    expect(card.spoken).toBe(intervention.text);
    expect(card.speech).toMatch(/^Queued for the tutor's voice/);
    expect(card.rules).toEqual([rule]);
    expect(card.rules[0]?.quote.text).toBe(QUOTE);
    expect(interventionCard(state, { ...intervention, speech: "spoken" }).speech).toBe("Spoken by the tutor");
    expect(interventionCard(state, { ...intervention, speech: "dropped" }).speech).toMatch(/^Not spoken/);
    expect(interventionCard(state, { ...intervention, trigger: "insufficient_information" }).headline).toMatch(/check the missing details/);
  });

  it("shows the intervention for the selected outcome only", () => {
    const v = view({ interventions: [intervention] });
    expect(activeIntervention(v, "approve")).toBe(intervention);
    expect(activeIntervention(v, "enhancedReview")).toBeUndefined();
    expect(activeIntervention(v, undefined)).toBeUndefined();
  });

  it("the reveal card states the verdict and teaches the deciding rule", () => {
    expect(revealCard(state, prediction)).toMatchObject({
      correct: false,
      verdict: "Not quite — you predicted “Approve onboarding”; the expert would send to enhanced review.",
      rules: [decisionRule],
    });
    expect(revealCard(state, { ...prediction, predicted: enhanced, correct: true }).verdict).toBe("Right — the expert would also send to enhanced review.");
  });

  it("the ladder has five steps, reached up to the level", () => {
    expect(ladder("independent_once").map((s) => s.reached)).toEqual([true, true, true, false, false]);
    expect(ladder("untested").map((s) => s.reached)).toEqual([false, false, false, false, false]);
    expect(ladder("mastered").every((s) => s.reached)).toBe(true);
    expect(ladder("untested").map((s) => s.label)).toEqual(["Untested", "Assisted", "Independently correct once", "Correct at a boundary case", "Mastered"]);
  });
});

describe("tutor API client", () => {
  it("posts the selection and validates the response", async () => {
    const { fetch, requests } = scriptedFetch(() =>
      jsonResponse({ result: { decision: "forbid", matchedRules: ["rule-never-approve"], missingFeatures: [], evidence: [] }, intervention, fresh: true }),
    );
    const r = await postIntent(fetch, "s-1", { caseId: "NS-2026-0201", proposedAction: approve, edits: { riskRating: "unrated" } });
    expect(r.intervention?.questionId).toBe("q-1");
    expect(requests[0]).toEqual({ url: "/api/sessions/s-1/tutor/intent", method: "POST", body: { caseId: "NS-2026-0201", proposedAction: "approve", edits: { riskRating: "unrated" } } });
    const broken = scriptedFetch(() => jsonResponse({ result: {}, intervention: null }));
    await expect(postIntent(broken.fetch, "s-1", { caseId: "x", proposedAction: approve, edits: {} })).rejects.toMatchObject({ code: "schema_mismatch" });
  });

  it("lists a session's cases with its generated ones", async () => {
    const { fetch, requests } = scriptedFetch(() => jsonResponse({ cases: [] }));
    await listCases(fetch, "heldout", "s-1");
    expect(requests[0]?.url).toBe("/api/cases?set=heldout&session=s-1");
  });
});
