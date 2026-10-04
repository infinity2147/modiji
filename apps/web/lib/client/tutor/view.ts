/**
 * Display models for the tutor's cards, kept pure so the wording the novice sees is tested: the
 * intervention card (the warning, the expert's words, whether the tutor has spoken), the reveal
 * card, the mastery ladder and the coach conversation (captions and the coach's state).
 */
import { MASTERY_LEVELS, type MasteryLevel } from "@vashistha/core";
import type { CaseTutorView, CoachTurnView, InterventionView, PredictionView, TutorRule, TutorState } from "../../contracts/tutor";
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

/** One caption line of the coach conversation. */
export type ConversationLine = { key: string; role: "coach" | "trainee"; text: string };

/** At most this many recent lines are shown: a caption strip, not a chat log. */
export const CONVERSATION_LINES = 4;

const sameText = (a: string, b: string): boolean => a.trim().toLowerCase() === b.trim().toLowerCase();

/**
 * The recent conversation, oldest first: the server's turns (`TutorState.coach`), then what this page knows
 * before the server has recorded it — the trainee's spoken words (final transcripts), a typed question in flight,
 * and the reply the chat call returned. A local line disappears once the server has the same words.
 */
export function conversationLines(input: {
  server: readonly Pick<CoachTurnView, "id" | "role" | "text">[];
  /** Final transcripts of the trainee's speech on this page (newest last). */
  spoken?: readonly { id: number; text: string }[];
  /** A typed question, sent and not answered yet (or just answered). */
  asked?: { text: string } | null;
  /** The coach's reply to that question, as the chat call returned it. */
  reply?: { text: string } | null;
  max?: number;
}): ConversationLine[] {
  const server = input.server.filter((t) => t.text.trim() !== "");
  const known = (role: ConversationLine["role"], text: string) => server.some((t) => t.role === role && sameText(t.text, text));
  const local: ConversationLine[] = [
    ...(input.spoken ?? []).filter((t) => !known("trainee", t.text)).map((t) => ({ key: `said:${t.id}`, role: "trainee" as const, text: t.text })),
    ...(input.asked && !known("trainee", input.asked.text) ? [{ key: "asked", role: "trainee" as const, text: input.asked.text }] : []),
    ...(input.reply && !known("coach", input.reply.text) ? [{ key: "reply", role: "coach" as const, text: input.reply.text }] : []),
  ];
  return [...server.map((t) => ({ key: t.id, role: t.role, text: t.text })), ...local].slice(-(input.max ?? CONVERSATION_LINES));
}

/** What the coach is doing, in one calm word for the trainee; null when there is nothing to say (no voice, idle). */
export type CoachActivity = "listening" | "thinking" | "speaking" | null;

export function coachActivity(input: {
  /** The tutor voice agent is connected. */
  voiceLive: boolean;
  /** The agent's audio is playing. */
  agentSpeaking: boolean;
  /** The browser voice is reading a coach line (text-only coaching). */
  browserSpeaking: boolean;
  /** A reply is on its way: a typed question in flight, or the trainee just finished speaking. */
  awaitingReply: boolean;
}): CoachActivity {
  if (input.agentSpeaking || input.browserSpeaking) return "speaking";
  if (input.awaitingReply) return "thinking";
  return input.voiceLive ? "listening" : null;
}

export const COACH_ACTIVITY_TEXT: Record<Exclude<CoachActivity, null>, string> = {
  listening: "Coach is listening…",
  thinking: "Coach is thinking…",
  speaking: "Coach is speaking…",
};
