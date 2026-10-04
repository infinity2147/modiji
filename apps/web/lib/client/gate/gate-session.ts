/**
 * The browser half of the speech gate (plan §7.2): runs the REAL core gate controller and wires it to
 * the server and the voice session. The gate alone decides when the agent speaks:
 *
 * - inputs: provider VAD, the local microphone detector, transcript arrivals and agent mode (voice),
 *   typing and screen motion (activity sensors), breakpoints (case opened / decision saved),
 *   off-record state, and the top of the server's question queue (polled every second, one request at
 *   a time, abortable);
 * - `issue` = POST gate/authorize (bounded by `AUTHORIZE_TIMEOUT_MS`); on success the control message
 *   is sent with `sendUserMessage` exactly once — unless the expert resumed while the request was in
 *   flight (withdrawn); a refusal (409) or a withdrawal is recorded, gives the live-budget slot back,
 *   and the queue is re-read;
 * - the queue is only offered to the gate while a voice conversation is live, so no question is spent
 *   (or recorded as authorized) when nobody could hear it;
 * - only the question kinds this page speaks are offered (`questionKinds`): the session's queue is shared by
 *   the CaseDesk interview and the debrief conversation, and each page's agent speaks its own questions only.
 */
import {
  CONDITION_LABELS,
  createGateController,
  QuestionKindSchema,
  type GateClock,
  type GateConditions,
  type GateConfigInput,
  type GateController,
  type GateEvaluation,
  type GateMode,
  type HudModel,
  type LatencySample,
  type Question,
  type QuestionKind,
} from "@vashistha/core";
import { ApiError, describeError, type FetchFn } from "../api";
import { authorizeQuestion, fetchQuestionQueue } from "./api";

export const QUEUE_POLL_MS = 1000;
/** A freshly opened case becomes a breakpoint once the reviewer has had a moment to take it in. */
export const CASE_SETTLE_MS = 1000;
/** Poll interval after the queue route failed (e.g. not deployed yet). */
export const QUEUE_RETRY_MS = 5000;
/**
 * The longest the gate waits for `gate/authorize` (it holds the floor meanwhile). A later answer is
 * dropped; the server re-queues the question when its unsent nonce expires.
 */
export const AUTHORIZE_TIMEOUT_MS = 10_000;

/**
 * The kinds a gate session offers by default: everything except `debrief_turn`. Debrief turns are spoken only
 * by the debrief page's voice loop, which asks for them explicitly; a live CaseDesk capture never speaks one
 * (a debrief left open in another tab still queues its turns in the same session).
 */
export const DEFAULT_QUESTION_KINDS: ReadonlySet<QuestionKind> = new Set(QuestionKindSchema.options.filter((k) => k !== "debrief_turn"));

export type GateRefusal = { questionId: string; at: number; code: string; message: string };

export type QueueStatus =
  | { state: "loading" }
  | { state: "ok"; at: number }
  | { state: "error"; at: number; message: string };

/** What the gate had asked; `kind` and `target` drive the browser's UI cue for it (voice/question-cues.ts). */
export type AskedQuestion = Pick<Question, "kind" | "target" | "text"> & { questionId: string; at: number };

export type GateSnapshot = {
  hud: HudModel;
  conditions: GateConditions;
  queue: readonly Question[];
  contextVersion: number | null;
  /** Live questions the server says were asked in this session. */
  serverAsked: number;
  queueStatus: QueueStatus;
  latency: readonly LatencySample[];
  refusals: readonly GateRefusal[];
  voiceLive: boolean;
  offRecord: boolean;
};

export type GateSessionOptions = {
  sessionId: string;
  mode: GateMode;
  fetch: FetchFn;
  clock: GateClock;
  cfg?: GateConfigInput;
  /** `sendUserMessage(controlMessage)` on the live conversation. */
  sendControlMessage: (text: string) => void;
  /** `sendUserActivity()`: a non-enforcing hint that the user is busy (the agent holds ~2 s). */
  holdAgent: () => void;
  /** A question was authorized and its control message sent: the next agent turn speaks it. */
  onAsked: (asked: AskedQuestion) => void;
  /** The question kinds this session may speak (default `DEFAULT_QUESTION_KINDS`); others in the queue are ignored. */
  questionKinds?: ReadonlySet<QuestionKind>;
  pollMs?: number;
};

export type GateSession = {
  snapshot: () => GateSnapshot;
  subscribe: (listener: () => void) => () => void;
  typing: () => void;
  screenMotion: () => void;
  /** Breakpoints (plan §7.2): a case was opened (a breakpoint after `CASE_SETTLE_MS`)… */
  caseOpened: () => void;
  /** …the reviewer is editing (not a breakpoint)… */
  edited: () => void;
  /** …a decision was committed (a breakpoint now). */
  committed: () => void;
  vad: (score: number) => void;
  /** The browser's microphone detector started or stopped hearing speech. */
  localSpeech: (speaking: boolean) => void;
  /** The provider transcribed the expert (`final`: their turn is finished at the provider). */
  transcript: (final: boolean) => void;
  agentSpeaking: (speaking: boolean) => void;
  setOffRecord: (on: boolean) => void;
  /** Whether a voice conversation is connected (the queue is offered to the gate only then). */
  setVoiceLive: (live: boolean) => void;
  /** Re-reads the queue now (after an authorization, a refusal or a decision). */
  refreshQueue: () => void;
  dispose: () => void;
};

const MAX_REFUSALS = 20;

export function createGateSession(options: GateSessionOptions): GateSession {
  const { clock, sessionId } = options;
  const pollMs = options.pollMs ?? QUEUE_POLL_MS;
  const questionKinds = options.questionKinds ?? DEFAULT_QUESTION_KINDS;
  const listeners = new Set<() => void>();
  /** Control messages by nonce, between `issue` and `onAuthorize`. */
  const controlMessages = new Map<string, string>();
  let queue: readonly Question[] = [];
  let contextVersion: number | null = null;
  let serverAsked = 0;
  let queueStatus: QueueStatus = { state: "loading" };
  let refusals: readonly GateRefusal[] = [];
  let voiceLive = false;
  let offRecord = false;
  let disposed = false;
  let pollAbort: AbortController | null = null;
  let cancelPoll: (() => void) | null = null;
  let cancelSettle: (() => void) | null = null;
  let current: { hud: HudModel; evaluation: GateEvaluation } | undefined;
  let snap: GateSnapshot | undefined;

  const notify = (): void => {
    snap = undefined;
    for (const listener of [...listeners]) listener();
  };

  const refuse = (questionId: string, code: string, message: string): void => {
    refusals = [{ questionId, at: clock.now(), code, message }, ...refusals].slice(0, MAX_REFUSALS);
    notify();
    refreshQueue();
  };

  const controller: GateController = createGateController({
    mode: options.mode,
    clock,
    ...(options.cfg !== undefined && { cfg: options.cfg }),
    issue: async (question, decision) => {
      const response = await authorizeQuestion(
        options.fetch,
        sessionId,
        {
          questionId: question.id,
          contextVersion: contextVersion ?? question.contextVersion,
          becameValidAt: Math.round(decision.becameValidAt),
          decidedAt: Math.round(decision.decidedAt),
          conditions: decision.conditions,
        },
        AUTHORIZE_TIMEOUT_MS,
      );
      controlMessages.set(response.authorization.nonce, response.controlMessage);
      return response.authorization;
    },
    onAuthorize: (authorization, question) => {
      const controlMessage = controlMessages.get(authorization.nonce);
      controlMessages.delete(authorization.nonce);
      if (controlMessage === undefined) return false;
      // The world changed while the server answered: never speak into it (the nonce simply expires).
      if (offRecord || !voiceLive) {
        refuse(
          question.id,
          offRecord ? "off_record" : "voice_disconnected",
          offRecord ? "Went off the record before the authorization arrived" : "Voice disconnected before the authorization arrived",
        );
        return false;
      }
      options.sendControlMessage(controlMessage);
      options.onAsked({ questionId: question.id, text: question.text, kind: question.kind, target: question.target, at: clock.now() });
      refreshQueue();
      return true;
    },
    onWithdraw: (authorization, question, conditions) => {
      controlMessages.delete(authorization.nonce);
      refuse(question.id, "withdrawn", `Not sent: the expert resumed (${conditions.map((k) => CONDITION_LABELS[k]).join(", ")}) before the authorization arrived`);
    },
    onHudUpdate: (hud, evaluation) => {
      current = { hud, evaluation };
      notify();
    },
    onHoldAgentHint: () => {
      if (voiceLive && !offRecord) options.holdAgent();
    },
    onError: (error, question) =>
      refuse(question.id, error instanceof ApiError ? error.code : "invalid_authorization", describeError(error)),
  });

  const offerTop = (): void => {
    controller.feed({ kind: "queue", t: clock.now(), top: voiceLive ? (queue[0] ?? null) : null });
  };

  function schedulePoll(delayMs: number): void {
    cancelPoll?.();
    cancelPoll = disposed ? null : clock.setTimer(poll, delayMs);
  }

  function poll(): void {
    cancelPoll = null;
    if (disposed || pollAbort !== null) return;
    const abort = new AbortController();
    pollAbort = abort;
    fetchQuestionQueue(options.fetch, sessionId, abort.signal).then(
      (response) => {
        if (abort.signal.aborted) return;
        pollAbort = null;
        // The server orders the queue; the top this page may speak is the first question of a kind it speaks.
        queue = response.queue.filter((q) => questionKinds.has(q.kind));
        contextVersion = response.contextVersion;
        serverAsked = response.asked.length;
        queueStatus = { state: "ok", at: clock.now() };
        offerTop();
        notify();
        schedulePoll(pollMs);
      },
      (error: unknown) => {
        if (abort.signal.aborted) return;
        pollAbort = null;
        queueStatus = { state: "error", at: clock.now(), message: describeError(error) };
        notify();
        schedulePoll(QUEUE_RETRY_MS);
      },
    );
  }

  const breakpoint = (at: boolean): void => {
    cancelSettle?.();
    cancelSettle = null;
    controller.feed({ kind: "breakpoint", t: clock.now(), at });
  };

  function refreshQueue(): void {
    if (disposed || pollAbort !== null) return;
    schedulePoll(0);
  }

  poll();

  return {
    snapshot() {
      if (snap) return snap;
      if (!current) throw new Error("gate: no evaluation yet");
      snap = {
        hud: current.hud,
        conditions: current.evaluation.conditions,
        queue,
        contextVersion,
        serverAsked,
        queueStatus,
        latency: [...controller.latencySamples()],
        refusals,
        voiceLive,
        offRecord,
      };
      return snap;
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    typing: () => controller.feed({ kind: "typing", t: clock.now() }),
    screenMotion: () => controller.feed({ kind: "screen_motion", t: clock.now() }),
    caseOpened() {
      breakpoint(false);
      cancelSettle = clock.setTimer(() => {
        cancelSettle = null;
        breakpoint(true);
      }, CASE_SETTLE_MS);
    },
    edited: () => breakpoint(false),
    committed() {
      breakpoint(true);
      refreshQueue();
    },
    vad: (score) => controller.feed({ kind: "vad", t: clock.now(), value: Math.min(1, Math.max(0, score)) }),
    localSpeech: (speaking) => controller.feed({ kind: "local_speech", t: clock.now(), value: speaking ? 1 : 0 }),
    transcript: (final) => controller.feed({ kind: final ? "user_transcript" : "tentative_transcript", t: clock.now() }),
    agentSpeaking: (speaking) => controller.feed({ kind: "agent_speaking", t: clock.now(), value: speaking ? 1 : 0 }),
    setOffRecord(on) {
      if (on === offRecord) return;
      offRecord = on;
      controller.feed({ kind: "off_record", t: clock.now(), on });
      notify();
    },
    setVoiceLive(live) {
      if (live === voiceLive) return;
      voiceLive = live;
      if (!live) controller.feed({ kind: "agent_speaking", t: clock.now(), value: 0 });
      offerTop();
      notify();
    },
    refreshQueue,
    dispose() {
      disposed = true;
      cancelPoll?.();
      cancelSettle?.();
      pollAbort?.abort();
      controller.dispose();
      listeners.clear();
    },
  };
}
