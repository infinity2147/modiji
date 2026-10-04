import type { Question } from "../schemas/engine";
import type { GateConfig } from "./config";
import { holdingFloor, userSpeaking, type GateState } from "./state";

export type GateMode = "interviewer" | "tutor";

/** `waitMs`: time until the condition becomes ok without new input; 0 if ok, Infinity if only an event can. */
export type Cond = { ok: boolean; waitMs: number };

export const CONDITION_KEYS = [
  "userSilent",
  "screenIdle",
  "typingIdle",
  "breakpointOrEphemeral",
  "valueAboveTheta",
  "budget",
  "notOffRecord",
  "agentIdle",
] as const;
export type ConditionKey = (typeof CONDITION_KEYS)[number];
export type GateConditions = Record<ConditionKey, Cond>;

/** Judge-facing names (plan §7.2 HUD); a failing condition reads "<label> wait". */
export const CONDITION_LABELS: Record<ConditionKey, string> = {
  userSilent: "Speaking",
  screenIdle: "Screen moving",
  typingIdle: "Typing",
  breakpointOrEphemeral: "Breakpoint",
  valueAboveTheta: "Question value",
  budget: "Budget",
  notOffRecord: "Off record",
  agentIdle: "Agent speaking",
};

export type GateEvaluation = {
  decision: "authorize" | "wait";
  conditions: GateConditions;
  /** When the required conditions last became (and have since stayed) valid; set iff authorizing. */
  becameValidAt: number | null;
  /** The candidate: the queue's top question unless it was already authorized. */
  question: Question | null;
  reason: string;
  /** Time until the decision can flip to authorize without new input: 0 if authorizing, else Infinity if only an event can. */
  readyInMs: number;
  /** The question an earlier authorization is still holding the floor for (judge HUD: ASKING). */
  inFlight: Question | null;
};

/** Plain-language "why this question", e.g. "contradiction detected · EIG 0.61 bits". */
export function describeQuestion(q: Question): string {
  return q.kind === "intervention"
    ? `${q.reason} · intervention: safety overrides politeness`
    : `${q.reason} · EIG ${q.value.toFixed(2)} bits`;
}

/** "0.8 s" (rounded up to 0.1 s) for a time-based wait; null when only an event can end it. */
export function formatWait(waitMs: number): string | null {
  return Number.isFinite(waitMs) ? `${(Math.ceil(waitMs / 100) / 10).toFixed(1)} s` : null;
}

/**
 * Each condition as the instant from which it holds (absent new input): `≤ now` means ok,
 * Infinity means only an event can make it ok, -Infinity means "always has".
 */
function conditionOkAt(s: GateState, q: Question | null, cfg: GateConfig): Record<ConditionKey, number> {
  // Silence counts from the last speech signal; an answer in progress needs the longer answer silence,
  // and a user turn the provider has not finalized holds the floor until its transcript (or the cap).
  const afterSpeech = Math.max(
    s.speechEndedAt + (s.answering ? cfg.answerSilenceMs : cfg.userSilenceMs),
    s.userTurnOpen ? s.speechEndedAt + cfg.transcriptWaitMs : Number.NEGATIVE_INFINITY,
  );
  // After an agent turn the expert has the floor: wait for an answer, or for the answer window to pass.
  const unanswered = s.agentTurnEndedAt > s.speechEndedAt;
  // The live budget binds live questions only, and only live questions spend it.
  const { max, windowMs, kinds } = cfg.liveBudget;
  const budgeted = q !== null && kinds.includes(q.kind);
  const spent = budgeted ? s.asked.filter((a) => kinds.includes(a.kind)) : [];
  const budgetSlot = spent.length < max ? undefined : spent[spent.length - max];
  return {
    userSilent: userSpeaking(s)
      ? Infinity
      : unanswered
        ? Math.max(afterSpeech, s.agentTurnEndedAt + cfg.answerWindowMs)
        : afterSpeech,
    screenIdle: s.lastActivityAt.screen_motion + cfg.screenIdleMs,
    typingIdle: s.lastActivityAt.typing + cfg.typingIdleMs,
    breakpointOrEphemeral: q?.ephemeral ? -Infinity : s.atBreakpoint ? s.breakpointSince : Infinity,
    valueAboveTheta: q !== null && q.value >= cfg.thetaAsk ? s.topSince : Infinity,
    budget: budgetSlot === undefined ? -Infinity : budgetSlot.at + windowMs,
    notOffRecord: s.offRecord ? Infinity : s.offRecordEndedAt,
    agentIdle: s.agentSpeaking ? Infinity : Math.max(s.agentTurnEndedAt, s.hold?.until ?? -Infinity),
  };
}

/**
 * The deterministic speech gate (plan §7.2): authorize iff the user is silent ≥ userSilenceMs (≥
 * answerSilenceMs while answering the agent, and with their last turn transcribed or transcriptWaitMs
 * past), the
 * screen and keyboard are idle, the work is at a breakpoint (or the question is ephemeral), the top
 * question is worth ≥ θ_ask, the live budget allows (live question kinds only), the session is on
 * the record and the agent is idle with nothing in flight. Tutor interventions need only "on the record" and an idle agent:
 * safety overrides politeness (plan §7.4). Off the record nothing is ever authorized (plan §7.8).
 */
export function evaluateGate(s: GateState, now: number, mode: GateMode, cfg: GateConfig): GateEvaluation {
  const top = s.top;
  const question =
    top !== null && !s.asked.some((a) => a.questionId === top.id) && s.refused?.questionId !== top.id ? top : null;
  const okAt = conditionOkAt(s, question, cfg);
  const conditions = Object.fromEntries(
    CONDITION_KEYS.map((k) => [k, { ok: okAt[k] <= now, waitMs: Math.max(0, okAt[k] - now) }]),
  ) as GateConditions;

  const intervention = mode === "tutor" && question?.kind === "intervention";
  const required: readonly ConditionKey[] = intervention ? ["notOffRecord", "agentIdle"] : CONDITION_KEYS;
  const readyAt = question === null ? Infinity : Math.max(s.topSince, ...required.map((k) => okAt[k]));
  const authorize = readyAt <= now;
  const inFlight = holdingFloor(s, now) ? (s.hold?.question ?? null) : null;

  let reason: string;
  if (s.offRecord) reason = "off the record: the agent stays silent";
  else if (question === null) reason = "no question queued";
  else if (authorize) reason = describeQuestion(question);
  else
    reason = `waiting: ${required
      .filter((k) => !conditions[k].ok)
      .map((k) => [CONDITION_LABELS[k], formatWait(conditions[k].waitMs)].filter((x) => x !== null).join(" "))
      .join(", ")}`;

  return {
    decision: authorize ? "authorize" : "wait",
    conditions,
    becameValidAt: authorize ? readyAt : null,
    question,
    reason,
    readyInMs: Math.max(0, readyAt - now),
    inFlight,
  };
}
