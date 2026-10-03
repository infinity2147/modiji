/**
 * Display models for the tutor's cards, kept pure so the wording the novice sees is tested: the
 * intervention card (the warning, the expert's words, whether the tutor has spoken), the reveal
 * card, and the mastery ladder.
 */
import { MASTERY_LEVELS, type MasteryLevel } from "@vashistha/core";
import type { CaseTutorView, InterventionView, PredictionView, TutorRule, TutorState } from "../../contracts/tutor";
import { actionLabel } from "../domain";

export type InterventionCardModel = {
  headline: string;
  /** What the tutor says (or said), exactly. */
  spoken: string;
  speech: string;
  rules: TutorRule[];
};

const SPEECH_TEXT: Record<InterventionView["speech"], string> = {
  queued: "Queued for the tutor's voice: spoken as soon as the agent is idle",
  spoken: "Spoken by the tutor",
  dropped: "Not spoken: the outcome was changed first",
};

function rulesOf(state: TutorState, ids: readonly string[]): TutorRule[] {
  return ids.flatMap((id) => state.rules.filter((r) => r.ruleId === id));
}

export function interventionCard(state: TutorState, intervention: InterventionView): InterventionCardModel {
  return {
    headline:
      intervention.trigger === "guardrail_violation"
        ? `Careful — the expert's rule forbids “${actionLabel(intervention.proposedAction)}” here`
        : `Careful — check the missing details before “${actionLabel(intervention.proposedAction)}”`,
    spoken: intervention.text,
    speech: SPEECH_TEXT[intervention.speech],
    rules: rulesOf(state, intervention.ruleIds),
  };
}

/** The warning for the outcome currently selected on the case, if the tutor gave one. */
export function activeIntervention(view: CaseTutorView | undefined, selected: string | undefined): InterventionView | undefined {
  if (view === undefined || selected === undefined) return undefined;
  return view.interventions.findLast((i) => i.proposedAction === selected);
}

export type RevealModel = { verdict: string; correct: boolean; expected: string; rules: TutorRule[] };

export function revealCard(state: TutorState, prediction: PredictionView): RevealModel {
  return {
    correct: prediction.correct,
    verdict: prediction.correct
      ? `Right — the expert would also ${actionLabel(prediction.expected).toLowerCase()}.`
      : `Not quite — you predicted “${actionLabel(prediction.predicted)}”; the expert would ${actionLabel(prediction.expected).toLowerCase()}.`,
    expected: actionLabel(prediction.expected),
    rules: rulesOf(state, prediction.ruleIds),
  };
}

export const LEVEL_LABELS: Record<MasteryLevel, string> = {
  untested: "Untested",
  assisted: "Assisted",
  independent_once: "Independently correct once",
  boundary_correct: "Correct at a boundary case",
  mastered: "Mastered",
};

/** The 5-step ladder with the reached steps marked; nothing is marked while the rule is untested. */
export function ladder(level: MasteryLevel): { level: MasteryLevel; label: string; reached: boolean }[] {
  const at = MASTERY_LEVELS.indexOf(level);
  return MASTERY_LEVELS.map((l, i) => ({ level: l, label: LEVEL_LABELS[l], reached: at > 0 && i <= at }));
}
