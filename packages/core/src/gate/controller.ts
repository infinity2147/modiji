import type { Question } from "../schemas/engine";
import { GateAuthorizationSchema, type GateAuthorization } from "../schemas/gate";
import { GateConfigSchema, type GateConfigInput } from "./config";
import { CONDITION_KEYS, evaluateGate, type ConditionKey, type GateEvaluation, type GateMode } from "./evaluate";
import { hudModel, type HudModel } from "./hud";
import { GateInputSchema, initialGateState, reduceGate, type GateInput } from "./state";

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
  /** Trigger the agent turn, e.g. `sendUserMessage(formatControlMessage(authorization.nonce))`. */
  onAuthorize: (authorization: GateAuthorization, question: Question, sample: LatencySample) => void;
  /** Called whenever the HUD model changes. */
  onHudUpdate: (hud: HudModel, evaluation: GateEvaluation) => void;
  /**
   * NON-ENFORCING hint, at most once per second while the user types: the web layer may call
   * `sendUserActivity()` so the agent holds off (~2 s). The gate alone decides when the agent speaks.
   */
  onHoldAgentHint?: () => void;
  /** `issue` failed or returned an invalid authorization. The question stays spent; its hold lapses at the TTL. */
  onError?: (error: unknown, question: Question) => void;
};

export type GateController = {
  /** Feeds one input (validated) and re-evaluates immediately. */
  feed: (input: GateInput) => void;
  latencySamples: () => readonly LatencySample[];
  dispose: () => void;
};

const HOLD_HINT_INTERVAL_MS = 1000;

/**
 * Runs the deterministic gate: re-evaluates on every input and on a timer that wakes exactly when
 * the conditions can next become valid (at most `tickMs` later, as a fallback for imprecise timers).
 * Authorizes each question at most once and never while an earlier authorization holds the floor.
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

  function settle(question: Question, becameValidAt: number, decidedAt: number, result: unknown): void {
    if (disposed) return;
    const parsed = GateAuthorizationSchema.safeParse(result);
    if (!parsed.success || parsed.data.questionId !== question.id) {
      onError(parsed.error ?? new Error("authorization is for another question"), question);
      return;
    }
    const authorizedAt = clock.now();
    const sample = {
      questionId: question.id,
      becameValidAt,
      decidedAt,
      authorizedAt,
      latencyMs: authorizedAt - becameValidAt,
    };
    samples.push(sample);
    opts.onAuthorize(parsed.data, question, sample);
  }

  function authorize(question: Question, becameValidAt: number, now: number, evaluation: GateEvaluation): void {
    state = reduceGate(state, { kind: "authorized", t: now, question, expiresAt: now + cfg.authorizationTtlMs }, cfg);
    const conditions = Object.fromEntries(CONDITION_KEYS.map((k) => [k, evaluation.conditions[k].ok])) as Record<
      ConditionKey,
      boolean
    >;
    let result: Promise<GateAuthorization> | GateAuthorization;
    try {
      result = opts.issue(question, { becameValidAt, decidedAt: now, conditions });
    } catch (error) {
      onError(error, question);
      return;
    }
    if (result instanceof Promise)
      result.then(
        (auth) => settle(question, becameValidAt, now, auth),
        (error: unknown) => onError(error, question),
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
    let evaluation = evaluateGate(state, now, mode, cfg);
    if (evaluation.decision === "authorize" && evaluation.question !== null && evaluation.becameValidAt !== null) {
      authorize(evaluation.question, evaluation.becameValidAt, now, evaluation);
      evaluation = evaluateGate(state, now, mode, cfg);
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
      if (parsed.kind === "typing" && parsed.t - lastHintAt >= HOLD_HINT_INTERVAL_MS) {
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
