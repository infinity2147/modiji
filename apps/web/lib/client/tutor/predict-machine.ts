/**
 * The review panel's predict-then-reveal flow for one open case (plan §7.7), as a pure reducer:
 *
 *   loading ──view──▶ ask ──choose/submit──▶ submitting ──submitted──▶ revealed
 *                 └──▶ skip (the server says not to ask, with the reason)
 *
 * The decision form is unlocked only in `skip` and `revealed`: at a decision node the novice has
 * not mastered, they first commit to what they think the expert would decide. The server decides
 * whether to ask and scores the prediction; nothing here knows the expected outcome before reveal.
 */
import type { ActionId } from "@vashistha/core";
import type { CaseTutorView, PredictionView } from "../../contracts/tutor";

export type PredictState =
  | { phase: "loading" }
  | { phase: "skip"; reason: string }
  | { phase: "ask"; choice: ActionId | undefined; submitting: boolean; error: string | undefined }
  | { phase: "revealed"; prediction: PredictionView };

export type PredictEvent =
  /** The tutor state for this case arrived or changed (undefined: not known yet). */
  | { type: "view"; view: CaseTutorView | undefined }
  | { type: "choose"; action: ActionId }
  | { type: "submit" }
  | { type: "submitted"; prediction: PredictionView }
  | { type: "failed"; message: string };

export const INITIAL_PREDICT_STATE: PredictState = { phase: "loading" };

export function predictReducer(state: PredictState, event: PredictEvent): PredictState {
  switch (event.type) {
    case "view": {
      const { view } = event;
      if (view === undefined) return state;
      if (view.prediction !== null) return { phase: "revealed", prediction: view.prediction };
      // A reveal is final for the case; a refresh racing the reveal never re-asks.
      if (state.phase === "revealed") return state;
      if (!view.prompt.ask) return { phase: "skip", reason: view.prompt.reason };
      return state.phase === "ask" ? state : { phase: "ask", choice: undefined, submitting: false, error: undefined };
    }
    case "choose":
      return state.phase === "ask" && !state.submitting ? { ...state, choice: event.action, error: undefined } : state;
    case "submit":
      return state.phase === "ask" && !state.submitting && state.choice !== undefined ? { ...state, submitting: true, error: undefined } : state;
    case "submitted":
      return state.phase === "ask" || state.phase === "loading" ? { phase: "revealed", prediction: event.prediction } : state;
    case "failed":
      return state.phase === "ask" ? { ...state, submitting: false, error: event.message } : state;
  }
}

/** The novice may choose and save an outcome. */
export function decisionUnlocked(state: PredictState): boolean {
  return state.phase === "skip" || state.phase === "revealed";
}
