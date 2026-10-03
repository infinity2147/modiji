import {
  DEFAULT_GATE_CONFIG,
  initialGateState,
  reduceGate,
  type GateConfig,
  type GateEvent,
  type GateInput,
  type GateState,
} from "../src/gate/index";
import type { Question, QuestionKind } from "../src/schemas/engine";

export function q(
  id: string,
  over: { value?: number; ephemeral?: boolean; kind?: QuestionKind; reason?: string; t?: number } = {},
): Question {
  return {
    id,
    sessionId: "s1",
    kind: over.kind ?? "counterfactual",
    text: "Would 24% ownership change your answer?",
    target: { candidateIds: [] },
    value: over.value ?? 0.61,
    reason: over.reason ?? "contradiction detected",
    ephemeral: over.ephemeral ?? false,
    createdAt: over.t ?? 0,
    contextVersion: 0,
    parentIds: [],
  };
}

export const queue = (t: number, top: Question | null): GateInput => ({ kind: "queue", t, top });

export function stateOf(events: readonly GateEvent[], cfg: GateConfig = DEFAULT_GATE_CONFIG): GateState {
  return events.reduce((s, e) => reduceGate(s, e, cfg), initialGateState());
}

/** Manual fake scheduler for controller tests. */
export function fakeClock(start = 0) {
  let now = start;
  let seq = 0;
  const timers: { at: number; seq: number; fn: () => void; live: boolean }[] = [];
  return {
    now: () => now,
    setTimer(fn: () => void, delayMs: number) {
      const timer = { at: now + delayMs, seq: seq++, fn, live: true };
      timers.push(timer);
      return () => {
        timer.live = false;
      };
    },
    /** Runs due timers in order up to `t`, then sets the clock to `t`. */
    advanceTo(t: number) {
      for (;;) {
        const next = timers.filter((x) => x.live && x.at <= t).sort((a, b) => a.at - b.at || a.seq - b.seq)[0];
        if (!next) break;
        next.live = false;
        now = Math.max(now, next.at);
        next.fn();
      }
      now = t;
    },
    pending: () => timers.filter((x) => x.live).length,
  };
}
