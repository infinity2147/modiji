import { z } from "zod";
import { QuestionSchema, type Question, type QuestionKind } from "../schemas/engine";
import { EpochMsSchema } from "../schemas/primitives";
import { ActivitySignalSchema, VoiceSignalSchema, type ActivitySignal } from "../schemas/signals";
import type { GateConfig } from "./config";

/**
 * Everything the gate listens to, each stamped with `t` (epoch ms).
 * - Voice: `vad` value = provider VAD score 0..1; `user_speaking`, `local_speech` (the browser's own
 *   microphone-level detector) and `agent_speaking` value 0 = stopped, anything else (or absent) =
 *   started; `tentative_transcript` / `user_transcript` = the provider transcribed the expert (point
 *   events; the final one closes the user turn); `turn_end` = the user's turn ended.
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

/**
 * The controller's own events about an authorization's lifecycle:
 * - `authorized`: the gate decided to ask `question`; the issuer's request is in flight. The budget
 *   slot is taken and the floor is held from this moment (never two authorizations in flight);
 * - `issued`: the authorization arrived and its control message went out; the floor is held until
 *   the agent has spoken, or for the TTL plus `authorizationGraceMs` if it never does;
 * - `refused`: the issuer refused or failed, or the control message could not be sent. Floor and
 *   budget slot are released, and the question is not tried again until the queue has been re-read;
 * - `withdrawn`: the authorization arrived but its control message was not sent (the world changed
 *   while the issuer answered). Floor and budget slot are released;
 * - `lapsed`: an issued authorization was never spoken by the end of its hold. Floor and budget slot
 *   are released (the server re-queues the question).
 */
export type GateLifecycleEvent =
  | { kind: "authorized"; t: number; question: Question }
  | { kind: "issued" | "refused" | "withdrawn"; t: number; questionId: string }
  | { kind: "lapsed"; t: number };
export type GateEvent = GateInput | GateLifecycleEvent;

type ActivityKind = ActivitySignal["kind"];

/** The latest authorization and the floor it holds until `until` (Infinity while in flight or spoken). */
export type GateHold = Readonly<{ question: Question; at: number; until: number; spoken: boolean }>;

/** `-Infinity` timestamps mean "never". */
export type GateState = Readonly<{
  /** Latest VAD score ≥ threshold. */
  vadSpeaking: boolean;
  /** Explicit `user_speaking` channel (ended by `user_speaking` 0 or `turn_end`). */
  explicitSpeaking: boolean;
  /** The browser's microphone-level detector. */
  localSpeaking: boolean;
  /** When the current (or latest) run of speech began. */
  speechStartedAt: number;
  /** When the user's latest speech ended: the first silent observation after it, or the latest transcript. */
  speechEndedAt: number;
  /**
   * Speech was detected and the provider has not finalized that user turn yet (`user_transcript`). The
   * gate stops waiting for the transcript `transcriptWaitMs` after the speech; the flag stays set until one arrives.
   */
  userTurnOpen: boolean;
  /** The expert is answering the agent's last question: they spoke since its turn, with no answer-ending silence. */
  answering: boolean;
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
  /** Authorizations that spent the live budget, oldest first (a refused, withdrawn or lapsed one is removed). */
  asked: readonly { questionId: string; kind: QuestionKind; at: number }[];
  hold: GateHold | null;
  /** The question the issuer last refused: not tried again until the queue is re-read after `at`. */
  refused: Readonly<{ questionId: string; at: number }> | null;
}>;

const NEVER = Number.NEGATIVE_INFINITY;

/**
 * A final transcript that arrives while speech is still heard covers that speech only if it began at
 * least this long before: the provider finalizes a turn 0.4–1.0 s after it ends (live), so a run of
 * speech that began more recently is the expert talking again — a new turn — while an older one is the
 * transcribed speech whose end the level channels still trail (VAD lag, detector hangover).
 */
const FINAL_COVERS_SPEECH_STARTED_MS = 1000;

export function initialGateState(): GateState {
  return {
    vadSpeaking: false,
    explicitSpeaking: false,
    localSpeaking: false,
    speechStartedAt: NEVER,
    speechEndedAt: NEVER,
    userTurnOpen: false,
    answering: false,
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
    refused: null,
  };
}

function isOn(value: number | undefined): boolean {
  return value !== 0;
}

/** Any speech channel says the user is speaking now. */
export function userSpeaking(s: GateState): boolean {
  return s.vadSpeaking || s.explicitSpeaking || s.localSpeaking;
}

/** Whether an authorization holds the floor at `t` (in flight, unspoken within its hold, or being spoken). */
export function holdingFloor(s: GateState, t: number): boolean {
  return s.hold !== null && t < s.hold.until;
}

/**
 * Speech began at `t` (a channel went from silence to speech, or a transcript arrived during silence).
 * It opens a user turn. The first speech after an agent turn starts the answer to it; speech after an
 * answer that has ended (silence ≥ answerSilenceMs) is ordinary talk.
 */
function onset(s: GateState, t: number, cfg: GateConfig): GateState {
  const answering = s.agentTurnEndedAt > s.speechEndedAt || (s.answering && t - s.speechEndedAt < cfg.answerSilenceMs);
  return { ...s, answering, userTurnOpen: true, speechStartedAt: t };
}

/** Applies one speech channel's new level; silence starts at the first silent observation. */
function speech(
  s: GateState,
  channel: "vadSpeaking" | "explicitSpeaking" | "localSpeaking",
  speaking: boolean,
  t: number,
  cfg: GateConfig,
): GateState {
  const next = { ...s, [channel]: speaking };
  if (!userSpeaking(s) && userSpeaking(next)) return onset(next, t, cfg);
  if (userSpeaking(s) && !userSpeaking(next)) return { ...next, speechEndedAt: Math.max(s.speechEndedAt, t) };
  return next;
}

/**
 * A transcript arrived at `t`: proof the expert spoke, even if no level channel heard it. While they
 * are silent, silence restarts from it. A final transcript closes the turn — while speech is still
 * heard, only if that speech began long enough ago to be what it transcribes.
 */
function transcript(s: GateState, t: number, final: boolean, cfg: GateConfig): GateState {
  if (userSpeaking(s)) return { ...s, userTurnOpen: !final || t - s.speechStartedAt < FINAL_COVERS_SPEECH_STARTED_MS };
  const spoke = { ...onset(s, t, cfg), speechEndedAt: Math.max(s.speechEndedAt, t) };
  return final ? { ...spoke, userTurnOpen: false } : spoke;
}

/** Whether a new top question restarts its validity clock (new question, or a gate-relevant change). */
function sameCandidate(a: Question | null, b: Question | null, thetaAsk: number): boolean {
  if (a === null || b === null) return a === b;
  return (
    a.id === b.id && a.kind === b.kind && a.ephemeral === b.ephemeral && a.value >= thetaAsk === b.value >= thetaAsk
  );
}

/** Releases the hold of `hold` and the budget slot it took. */
function release(s: GateState, hold: GateHold): GateState {
  const index = s.asked.findLastIndex((a) => a.questionId === hold.question.id && a.at === hold.at);
  return { ...s, hold: null, asked: index < 0 ? s.asked : s.asked.toSpliced(index, 1) };
}

/** Pure reducer over timestamped gate events. */
export function reduceGate(s: GateState, e: GateEvent, cfg: GateConfig): GateState {
  switch (e.kind) {
    case "vad":
      return speech(s, "vadSpeaking", (e.value ?? 0) >= cfg.vadSpeakingThreshold, e.t, cfg);
    case "user_speaking":
      return speech(s, "explicitSpeaking", isOn(e.value), e.t, cfg);
    case "local_speech":
      return speech(s, "localSpeaking", isOn(e.value), e.t, cfg);
    case "tentative_transcript":
      return transcript(s, e.t, false, cfg);
    case "user_transcript":
      return transcript(s, e.t, true, cfg);
    case "turn_end": {
      const ended = speech(s, "explicitSpeaking", false, e.t, cfg);
      return { ...ended, userTurnOpen: userSpeaking(ended) };
    }
    case "agent_speaking": {
      if (isOn(e.value) === s.agentSpeaking) return s;
      if (isOn(e.value))
        return {
          ...s,
          agentSpeaking: true,
          answering: false,
          hold: s.hold && { ...s.hold, until: Number.POSITIVE_INFINITY, spoken: true },
        };
      // The agent's turn is over: the next speech answers it (or the expert is already answering over its end).
      return { ...s, agentSpeaking: false, agentTurnEndedAt: e.t, answering: userSpeaking(s), hold: s.hold && { ...s.hold, until: e.t } };
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
    case "queue": {
      const refused = s.refused !== null && e.t > s.refused.at ? null : s.refused;
      return sameCandidate(s.top, e.top, cfg.thetaAsk) ? { ...s, top: e.top, refused } : { ...s, top: e.top, topSince: e.t, refused };
    }
    case "authorized":
      return {
        ...s,
        asked: [...s.asked, { questionId: e.question.id, kind: e.question.kind, at: e.t }],
        hold: { question: e.question, at: e.t, until: Number.POSITIVE_INFINITY, spoken: false },
        refused: null,
      };
    case "issued":
      if (s.hold?.question.id !== e.questionId || s.hold.spoken) return s;
      return { ...s, hold: { ...s.hold, until: e.t + cfg.authorizationTtlMs + cfg.authorizationGraceMs } };
    case "refused":
    case "withdrawn": {
      if (s.hold?.question.id !== e.questionId || s.hold.spoken) return s;
      const released = release(s, s.hold);
      return e.kind === "refused" ? { ...released, refused: { questionId: e.questionId, at: e.t } } : released;
    }
    case "lapsed":
      if (s.hold === null || s.hold.spoken || e.t < s.hold.until) return s;
      return release(s, s.hold);
  }
}
