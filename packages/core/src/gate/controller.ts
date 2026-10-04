import type { Question } from "../schemas/engine";
import { GateAuthorizationSchema, type GateAuthorization } from "../schemas/gate";
import { GateConfigSchema, type GateConfigInput } from "./config";
import { CONDITION_KEYS, evaluateGate, type ConditionKey, type GateEvaluation, type GateMode } from "./evaluate";
import { hudModel, type HudModel } from "./hud";
import { GateInputSchema, holdingFloor, initialGateState, reduceGate, userSpeaking, type GateInput, type GateState } from "./state";

/** Injected time source and scheduler (`setTimeout`/`clearTimeout` in production, a fake in simulation). */
export type GateClock = { now: () => number; setTimer: (fn: () => void, delayMs: number) => () => void };

export const systemClock: GateClock = {
  now: () => Date.now(),
  setTimer: (fn, delayMs) => {
    const id = setTimeout(fn, delayMs);
    return () => clearTimeout(id);
  },
};

export type LatencySample = {
  questionId: string;
  becameValidAt: number;
  /** When the gate decided and called `issue`. */
  decidedAt: number;
  /** When `issue` returned the authorization (includes the issuer's round trip). */
  authorizedAt: number;
  latencyMs: number;
};

/** The evaluation the gate authorized on: what the issuer records with the authorization (`gate.authorized`). */
export type GateDecision = {
  becameValidAt: number;
  decidedAt: number;
  /** Per-condition snapshot at the moment of the decision. */
  conditions: Record<ConditionKey, boolean>;
};

export type GateControllerOptions = {
  cfg?: GateConfigInput;
  mode: GateMode;
  clock: GateClock;
  /** Mints the single-use authorization (the server's nonce store, directly or over HTTP). */
  issue: (question: Question, decision: GateDecision) => Promise<GateAuthorization> | GateAuthorization;
  /**
   * Trigger the agent turn, e.g. `sendUserMessage(formatControlMessage(authorization.nonce))`. Returns
   * whether the control message was sent; `false` gives the authorization up like a refusal (floor and
   * budget slot released, the question waits for the queue to be re-read; the unsent nonce expires).
   */
  onAuthorize: (authorization: GateAuthorization, question: Question, sample: LatencySample) => boolean;
  /**
   * The authorization arrived after the expert resumed (spoke, typed, moved the screen or went off the
   * record) while the issuer answered: its control message is not sent, and floor and budget slot are
   * released. `conditions` are the ones that no longer hold.
   */
  onWithdraw?: (authorization: GateAuthorization, question: Question, conditions: readonly ConditionKey[]) => void;
  /** Called whenever the HUD model changes. */
  onHudUpdate: (hud: HudModel, evaluation: GateEvaluation) => void;
  /**
   * NON-ENFORCING hint, at most once per second while the user types: the web layer may call
   * `sendUserActivity()` so the agent holds off (~2 s). The gate alone decides when the agent speaks.
   * Never hinted while a user turn is open (a ping keeps the provider's turn open, so a later control
   * message would merge into it and go unspoken — live bug #1) or while an authorization holds the floor.
   */
  onHoldAgentHint?: () => void;
  /**
   * `issue` failed or returned an invalid authorization. Floor and budget slot are released; the
   * question is tried again only after the queue has been re-read.
   */
  onError?: (error: unknown, question: Question) => void;
};

export type GateController = {
  /** Feeds one input (validated) and re-evaluates immediately. */
  feed: (input: GateInput) => void;
  latencySamples: () => readonly LatencySample[];
  dispose: () => void;
};

const HOLD_HINT_INTERVAL_MS = 1000;

/** What must still hold when an authorization arrives for its control message to be sent (politeness and privacy). */
const SEND_CONDITIONS: readonly ConditionKey[] = ["userSilent", "screenIdle", "typingIdle", "notOffRecord"];

/** Whether a typing hint may be sent: no speech, no open user turn, nothing holding the floor. */
function holdHintAllowed(s: GateState, t: number): boolean {
  return !userSpeaking(s) && !s.userTurnOpen && !holdingFloor(s, t);
}

/**
 * Runs the deterministic gate: re-evaluates on every input and on a timer that wakes exactly when
 * the conditions can next become valid (at most `tickMs` later, as a fallback for imprecise timers).
 * Authorizes each question at most once per authorization lifecycle and never while an earlier
 * authorization holds the floor — from the moment the issuer is called, through its round trip, until
 * the agent has spoken it or it lapsed. When the authorization arrives, the conditions the expert
 * controls (speech, typing, screen, privacy) are checked again: if they no longer hold, it is withdrawn.
 */
export function createGateController(opts: GateControllerOptions): GateController {
  const cfg = GateConfigSchema.parse(opts.cfg ?? {});
  const { clock, mode } = opts;
  const onError = opts.onError ?? ((error: unknown) => console.error("gate: authorization failed", error));
  let state = initialGateState();
  let cancelTimer: (() => void) | null = null;
  let lastHud = "";
  let lastHintAt = Number.NEGATIVE_INFINITY;
  let disposed = false;
  const samples: LatencySample[] = [];

  function refuse(question: Question, error: unknown): void {
    state = reduceGate(state, { kind: "refused", t: clock.now(), questionId: question.id }, cfg);
    onError(error, question);
    step();
  }

  function settle(question: Question, becameValidAt: number, decidedAt: number, result: unknown): void {
    if (disposed) return;
    const parsed = GateAuthorizationSchema.safeParse(result);
    if (!parsed.success || parsed.data.questionId !== question.id) {
      refuse(question, parsed.error ?? new Error("authorization is for another question"));
      return;
    }
    const authorizedAt = clock.now();
    const polite = mode === "tutor" && question.kind === "intervention" ? ["notOffRecord" as const] : SEND_CONDITIONS;
    const conditions = evaluateGate(state, authorizedAt, mode, cfg).conditions;
    const broken = polite.filter((k) => !conditions[k].ok);
    if (broken.length > 0) {
      state = reduceGate(state, { kind: "withdrawn", t: authorizedAt, questionId: question.id }, cfg);
      opts.onWithdraw?.(parsed.data, question, broken);
      step();
      return;
    }
    state = reduceGate(state, { kind: "issued", t: authorizedAt, questionId: question.id }, cfg);
    const sample = {
      questionId: question.id,
      becameValidAt,
      decidedAt,
      authorizedAt,
      latencyMs: authorizedAt - becameValidAt,
    };
    if (opts.onAuthorize(parsed.data, question, sample)) samples.push(sample);
    else state = reduceGate(state, { kind: "refused", t: clock.now(), questionId: question.id }, cfg);
    step();
  }

  function authorize(question: Question, becameValidAt: number, now: number, evaluation: GateEvaluation): void {
    state = reduceGate(state, { kind: "authorized", t: now, question }, cfg);
    const conditions = Object.fromEntries(CONDITION_KEYS.map((k) => [k, evaluation.conditions[k].ok])) as Record<
      ConditionKey,
      boolean
    >;
    let result: Promise<GateAuthorization> | GateAuthorization;
    try {
      result = opts.issue(question, { becameValidAt, decidedAt: now, conditions });
    } catch (error) {
      refuse(question, error);
      return;
    }
    if (result instanceof Promise)
      result.then(
        (auth) => settle(question, becameValidAt, now, auth),
        (error: unknown) => {
          if (!disposed) refuse(question, error);
        },
      );
    else settle(question, becameValidAt, now, result);
  }

  function clearTimer(): void {
    cancelTimer?.();
    cancelTimer = null;
  }

  function step(): void {
    clearTimer();
    if (disposed) return;
    const now = clock.now();
    state = reduceGate(state, { kind: "lapsed", t: now }, cfg);
    let evaluation = evaluateGate(state, now, mode, cfg);
    if (evaluation.decision === "authorize" && evaluation.question !== null && evaluation.becameValidAt !== null) {
      authorize(evaluation.question, evaluation.becameValidAt, now, evaluation);
      evaluation = evaluateGate(state, clock.now(), mode, cfg);
    }
    const hud = hudModel(evaluation);
    const key = JSON.stringify(hud);
    if (key !== lastHud) {
      lastHud = key;
      opts.onHudUpdate(hud, evaluation);
    }
    // `onAuthorize`/`onHudUpdate` may have fed an input (re-entering `step`): keep only the newest timer.
    clearTimer();
    if (!disposed) cancelTimer = clock.setTimer(step, Math.min(evaluation.readyInMs, cfg.tickMs));
  }

  step();
  return {
    feed(input) {
      const parsed = GateInputSchema.parse(input);
      state = reduceGate(state, parsed, cfg);
      if (parsed.kind === "typing" && parsed.t - lastHintAt >= HOLD_HINT_INTERVAL_MS && holdHintAllowed(state, parsed.t)) {
        lastHintAt = parsed.t;
        opts.onHoldAgentHint?.();
      }
      step();
    },
    latencySamples: () => samples,
    dispose() {
      disposed = true;
      clearTimer();
    },
  };
}
