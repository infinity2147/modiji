/**
 * UI cues for the question being spoken (plan §7.4 `highlight_field`, `show_gap`). Triggered by the browser
 * itself, deterministically, not by an LLM tool call: the custom LLM only ever streams the authorised text
 * (a speech turn never carries a tool call), and the browser already knows the question the gate authorised
 * — its kind and target. The cue runs when the agent starts speaking after that authorization, so a
 * question the custom LLM did not speak (expired or refused nonce) shows nothing.
 *
 * - counterfactual with a target feature → `highlight_field`: scroll to and flash the case-file element
 *   marked `data-features~="<feature>"`;
 * - witness (solver gap) → `show_gap`: scroll to and flash `[data-witness-id="<id>"]` when the debrief shows
 *   it, otherwise say where the gap will be reviewed.
 *
 * Every other kind has no cue (interventions would `replay_moment`, which needs a replay view that does not
 * exist yet). A cue whose target is not on screen reports that, and never throws.
 */
import type { Question } from "@vashistha/core";
import { featureLabel } from "../domain";

export type QuestionCue = { action: "highlight_field"; feature: string } | { action: "show_gap"; witnessId: string };

export type CueResult = { action: QuestionCue["action"]; shown: boolean; message: string; at: number };

/** The part of a DOM element a cue uses (an `HTMLElement` in the browser). */
export type CueElement = {
  scrollIntoView: (options: ScrollIntoViewOptions) => void;
  animate: (keyframes: Keyframe[], options: KeyframeAnimationOptions) => unknown;
};

export type CueDom = { findAll: (selector: string) => readonly CueElement[] };

export const browserCueDom: CueDom = {
  findAll: (selector) => [...document.querySelectorAll<HTMLElement>(selector)],
};

/** Markup for case-file elements that show domain features: `<dd {...featureTargets("pep", "uboVerified")}>`. */
export function featureTargets(...features: string[]): { "data-features": string } {
  return { "data-features": features.join(" ") };
}

/** Markup for an element that shows a solver gap. */
export function witnessTarget(witnessId: string): { "data-witness-id": string } {
  return { "data-witness-id": witnessId };
}

/** Ids are interpolated into attribute selectors, so anything else is treated as "not on screen". */
const SELECTOR_SAFE = /^[A-Za-z0-9_.:-]{1,128}$/;

const FLASH: Keyframe[] = [
  { boxShadow: "0 0 0 3px rgb(245 158 11 / 0.95)", backgroundColor: "rgb(254 243 199 / 0.9)" },
  { boxShadow: "0 0 0 3px rgb(245 158 11 / 0)", backgroundColor: "rgb(254 243 199 / 0)" },
];
const FLASH_OPTIONS: KeyframeAnimationOptions = { duration: 2400, easing: "ease-out" };

export function cueFor(question: Pick<Question, "kind" | "target">): QuestionCue | null {
  const { kind, target } = question;
  if (kind === "witness" && target.witnessId !== undefined) return { action: "show_gap", witnessId: target.witnessId };
  if (kind === "counterfactual" && target.feature !== undefined) return { action: "highlight_field", feature: target.feature };
  return null;
}

function flash(dom: CueDom, selector: string): boolean {
  const elements = dom.findAll(selector);
  const [first] = elements;
  if (first === undefined) return false;
  first.scrollIntoView({ block: "center", behavior: "smooth" });
  for (const element of elements) element.animate(FLASH, FLASH_OPTIONS);
  return true;
}

export function runCue(cue: QuestionCue, dom: CueDom, at: number): CueResult {
  if (cue.action === "highlight_field") {
    const label = featureLabel(cue.feature);
    const shown = SELECTOR_SAFE.test(cue.feature) && flash(dom, `[data-features~="${cue.feature}"]`);
    return { action: cue.action, shown, at, message: shown ? `Highlighted “${label}” in the case file` : `“${label}” is not on screen` };
  }
  const shown = SELECTOR_SAFE.test(cue.witnessId) && flash(dom, `[data-witness-id="${cue.witnessId}"]`);
  return {
    action: cue.action,
    shown,
    at,
    message: shown ? "Showing the solver gap this question closes" : "This question closes a solver gap — review it in the debrief",
  };
}

export type CueScheduler = {
  /** The gate authorised `question`: its cue (if any) runs when the agent starts speaking. */
  armed: (question: Pick<Question, "kind" | "target">) => void;
  agentMode: (mode: "speaking" | "listening") => void;
  /** The conversation ended: nothing is pending. */
  reset: () => void;
};

export function createCueScheduler(options: { dom: CueDom; now: () => number; onCue: (result: CueResult) => void }): CueScheduler {
  let pending: QuestionCue | null = null;
  return {
    armed(question) {
      pending = cueFor(question);
    },
    agentMode(mode) {
      if (mode !== "speaking" || pending === null) return;
      const cue = pending;
      pending = null;
      options.onCue(runCue(cue, options.dom, options.now()));
    },
    reset() {
      pending = null;
    },
  };
}
