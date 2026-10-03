import { z } from "zod";
import { QuestionSchema, type Question } from "../schemas/engine";
import { EpochMsSchema } from "../schemas/primitives";
import { ActivitySignalSchema, VoiceSignalSchema, type ActivitySignal } from "../schemas/signals";
import type { GateConfig } from "./config";

/**
 * Everything the gate listens to, each stamped with `t` (epoch ms).
 * - Voice (`onVadScore`, `onModeChange`): `vad` value = score 0..1; `user_speaking` / `agent_speaking`
 *   value 0 = stopped, anything else (or absent) = started; `turn_end` = the user's turn ended.
 * - Activity: `typing` per keystroke, `screen_motion` per detected screen change. `pointer`,
 *   `focus_change` and `idle` are tracked for telemetry but do not gate speech (plan §7.2).
 * - `breakpoint`: a natural pause in the work (case opened, decision saved, explicit pause) starts
 *   (`at: true`) or ends (`at: false`, sent when work resumes).
 * - `off_record`: the expert went off (`on: true`) or back on the record.
 * - `queue`: the engine's current top question, or null.
 */
export const GateInputSchema = z.discriminatedUnion("kind", [
  VoiceSignalSchema,
  ActivitySignalSchema,
  z.strictObject({ kind: z.literal("breakpoint"), t: EpochMsSchema, at: z.boolean() }),
  z.strictObject({ kind: z.literal("off_record"), t: EpochMsSchema, on: z.boolean() }),
  z.strictObject({ kind: z.literal("queue"), t: EpochMsSchema, top: QuestionSchema.nullable() }),
]);
export type GateInput = z.infer<typeof GateInputSchema>;

/** Recorded by the controller the moment it authorizes `question`; feeds the budget and the hold. */
export type GateAuthorizedEvent = { kind: "authorized"; t: number; question: Question; expiresAt: number };
export type GateEvent = GateInput | GateAuthorizedEvent;

type ActivityKind = ActivitySignal["kind"];

/** `-Infinity` timestamps mean "never". */
export type GateState = Readonly<{
  /** Latest VAD score ≥ threshold. */
  vadSpeaking: boolean;
  /** Explicit `user_speaking` channel (ended by `user_speaking` 0 or `turn_end`). */
  explicitSpeaking: boolean;
  /** When the user's latest speech ended: the first observation of silence after it. */
  speechEndedAt: number;
  agentSpeaking: boolean;
  agentTurnEndedAt: number;
  lastActivityAt: Readonly<Record<ActivityKind, number>>;
  atBreakpoint: boolean;
  breakpointSince: number;
  offRecord: boolean;
  offRecordEndedAt: number;
  top: Question | null;
  /** When the top question last became (or changed in a way that matters to) a candidate. */
  topSince: number;
  /** Every authorization issued, oldest first (budget, and never the same question twice). */
  asked: readonly { questionId: string; at: number }[];
  /**
   * The latest authorization, holding the floor until `until`: its expiry while unspoken, Infinity
   * while the agent speaks, then the end of the agent's turn. Never two in flight.
   */
  hold: Readonly<{ question: Question; at: number; until: number }> | null;
}>;

const NEVER = Number.NEGATIVE_INFINITY;

export function initialGateState(): GateState {
  return {
    vadSpeaking: false,
    explicitSpeaking: false,
    speechEndedAt: NEVER,
    agentSpeaking: false,
    agentTurnEndedAt: NEVER,
    lastActivityAt: { typing: NEVER, pointer: NEVER, focus_change: NEVER, screen_motion: NEVER, idle: NEVER },
    atBreakpoint: false,
    breakpointSince: NEVER,
    offRecord: false,
    offRecordEndedAt: NEVER,
    top: null,
    topSince: NEVER,
    asked: [],
    hold: null,
  };
}

function isOn(value: number | undefined): boolean {
  return value !== 0;
}

function userSpeaking(s: GateState): boolean {
  return s.vadSpeaking || s.explicitSpeaking;
}

/** Applies one speech channel's new state; silence starts at the first silent observation. */
function speech(s: GateState, channel: "vadSpeaking" | "explicitSpeaking", speaking: boolean, t: number): GateState {
  const next = { ...s, [channel]: speaking };
  return userSpeaking(s) && !userSpeaking(next) ? { ...next, speechEndedAt: Math.max(s.speechEndedAt, t) } : next;
}

/** Whether a new top question restarts its validity clock (new question, or a gate-relevant change). */
function sameCandidate(a: Question | null, b: Question | null, thetaAsk: number): boolean {
  if (a === null || b === null) return a === b;
  return (
    a.id === b.id && a.kind === b.kind && a.ephemeral === b.ephemeral && a.value >= thetaAsk === b.value >= thetaAsk
  );
}

/** Pure reducer over timestamped gate events. */
export function reduceGate(s: GateState, e: GateEvent, cfg: GateConfig): GateState {
  switch (e.kind) {
    case "vad":
      return speech(s, "vadSpeaking", (e.value ?? 0) >= cfg.vadSpeakingThreshold, e.t);
    case "user_speaking":
      return speech(s, "explicitSpeaking", isOn(e.value), e.t);
    case "turn_end":
      return speech(s, "explicitSpeaking", false, e.t);
    case "agent_speaking": {
      if (isOn(e.value) === s.agentSpeaking) return s;
      if (isOn(e.value))
        return { ...s, agentSpeaking: true, hold: s.hold && { ...s.hold, until: Number.POSITIVE_INFINITY } };
      return { ...s, agentSpeaking: false, agentTurnEndedAt: e.t, hold: s.hold && { ...s.hold, until: e.t } };
    }
    case "typing":
    case "pointer":
    case "focus_change":
    case "screen_motion":
    case "idle":
      return { ...s, lastActivityAt: { ...s.lastActivityAt, [e.kind]: Math.max(s.lastActivityAt[e.kind], e.t) } };
    case "breakpoint":
      if (e.at === s.atBreakpoint) return s;
      return { ...s, atBreakpoint: e.at, breakpointSince: e.at ? e.t : s.breakpointSince };
    case "off_record":
      if (e.on === s.offRecord) return s;
      return { ...s, offRecord: e.on, offRecordEndedAt: e.on ? s.offRecordEndedAt : e.t };
    case "queue":
      return sameCandidate(s.top, e.top, cfg.thetaAsk) ? { ...s, top: e.top } : { ...s, top: e.top, topSince: e.t };
    case "authorized":
      return {
        ...s,
        asked: [...s.asked, { questionId: e.question.id, at: e.t }],
        hold: { question: e.question, at: e.t, until: e.expiresAt },
      };
  }
}
