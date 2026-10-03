/** Fixtures for the voice / gate / judge client tests: a manual clock, questions and ledger entries. */
import type { GateClock, LedgerEntry, LedgerSource, Question } from "@vashistha/core";

/** A manual clock: timers fire only when the test advances time, in time then creation order. */
export function manualClock(start = 1_700_000_000_000) {
  let now = start;
  let seq = 0;
  let timers: { at: number; seq: number; fn: () => void; live: boolean }[] = [];
  const clock: GateClock = {
    now: () => now,
    setTimer: (fn, delayMs) => {
      const timer = { at: now + delayMs, seq: seq++, fn, live: true };
      timers.push(timer);
      return () => {
        timer.live = false;
      };
    },
  };
  return {
    clock,
    now: () => now,
    advance(ms: number) {
      const until = now + ms;
      for (;;) {
        timers = timers.filter((t) => t.live);
        const next = timers.filter((t) => t.at <= until).sort((a, b) => a.at - b.at || a.seq - b.seq)[0];
        if (!next) break;
        next.live = false;
        now = Math.max(now, next.at);
        next.fn();
      }
      now = until;
    },
  };
}

export function question(id: string, over: Partial<Question> = {}): Question {
  return {
    id,
    sessionId: "s-1",
    kind: "counterfactual",
    text: "You sent this one to enhanced review but not the last — was it the ownership share or the jurisdiction?",
    target: { candidateIds: [] },
    value: 0.61,
    reason: "contradiction detected",
    ephemeral: false,
    createdAt: 1_700_000_000_000,
    contextVersion: 4,
    parentIds: [],
    ...over,
  };
}

let sequence = 0;

/** A ledger entry as the ledger route returns it. */
export function entry(kind: string, source: LedgerSource, payload: unknown, over: Partial<LedgerEntry> = {}): LedgerEntry {
  sequence += 1;
  return {
    id: `entry-${sequence}`,
    sequence,
    receivedAt: 1_700_000_000_000 + sequence,
    sessionId: "s-1",
    source,
    kind,
    occurredAt: 1_700_000_000_000 + sequence,
    traceId: "trace-1",
    parentIds: [],
    schemaVersion: 1,
    privacyEpoch: 0,
    payload,
    ...over,
  };
}
