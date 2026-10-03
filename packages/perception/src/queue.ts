/**
 * Ordered perception queue, one per session (plan §7.1, §7.8, §13 "stale vision responses").
 * Isomorphic. Code, not the model, decides ordering and staleness:
 *
 * - every submitted frame gets the next monotonic `frameSeq`;
 * - at most ONE request is in flight; while it runs, only the newest pending frame is kept
 *   (older pending frames are coalesced away and counted);
 * - a frame stamped with a privacy epoch other than the current one is refused at submit;
 * - `cancelAll()` drops the pending frame and aborts the in-flight request, whose result can then
 *   never be applied; `setEpoch()` does the same and moves to the new epoch;
 * - results reach the caller's `apply` only through the state applier, which refuses any result
 *   whose frameSeq is not newer than the last applied or whose epoch is not current.
 *
 * The in-flight slot is released only when the request settles (abort makes that prompt for a
 * fetch-based `send`), so "one in flight" holds strictly even across cancellation.
 */

export type PerceptionFrame<P> = { frameSeq: number; captureTime: number; epoch: number; payload: P };

export type StateApplier<R> = {
  /** Applies `result` if it is fresh; returns whether it was applied. */
  offer(frame: { frameSeq: number; epoch: number }, result: R): boolean;
  lastApplied(): number;
};

/**
 * Staleness guard: a result is applied only if its frameSeq is greater than the last applied one
 * and its epoch equals `currentEpoch()` at the moment of application.
 */
export function createStateApplier<R>(options: {
  currentEpoch: () => number;
  apply: (result: R, frame: { frameSeq: number; epoch: number }) => void;
  /** frameSeq already applied before this applier existed (e.g. recovered from the ledger). */
  lastApplied?: number;
}): StateApplier<R> {
  let last = options.lastApplied ?? 0;
  return {
    offer(frame, result) {
      if (frame.frameSeq <= last || frame.epoch !== options.currentEpoch()) return false;
      last = frame.frameSeq;
      options.apply(result, frame);
      return true;
    },
    lastApplied: () => last,
  };
}

export type QueueStats = {
  submitted: number;
  /** Requests started. */
  sent: number;
  /** 0 or 1. */
  inFlight: number;
  /** frameSeq of the frame waiting for the slot, if any. */
  pendingFrameSeq: number | null;
  /** Pending frames replaced by a newer one before they were sent. */
  coalesced: number;
  applied: number;
  /** Results refused by the state applier (cancelled, superseded or from a past epoch). */
  staleDropped: number;
  /** Pending frames dropped by `cancelAll`/`setEpoch`. */
  cancelled: number;
  /** Frames refused at submit because their epoch was not current. */
  epochRejected: number;
  /** Requests whose `send` rejected. */
  failed: number;
  /** Capture → result applied, ms, one sample per applied frame (most recent `maxSamples`). */
  frameToApplyMs: number[];
  /** Request start → settle, ms, one sample per request that resolved (most recent `maxSamples`). */
  requestMs: number[];
};

export type PerceptionQueueOptions<P, R> = {
  /** Privacy epoch at creation. */
  epoch: number;
  send: (frame: PerceptionFrame<P>, signal: AbortSignal) => Promise<R>;
  apply: (result: R, frame: PerceptionFrame<P>) => void;
  /** Clock in ms, same timebase as `captureTime`. */
  now: () => number;
  onError?: (error: unknown, frame: PerceptionFrame<P>) => void;
  /** Last frameSeq used by this session before the queue was created (default 0). */
  lastFrameSeq?: number;
  maxSamples?: number;
};

export type PerceptionQueue<P> = {
  /** Queues a frame captured under `epoch`; returns it with its frameSeq, or null if the epoch is stale. */
  submit(payload: P, captureTime: number, epoch: number): PerceptionFrame<P> | null;
  /** Drops the pending frame and aborts the in-flight request; neither can be applied afterwards. */
  cancelAll(): void;
  /** Moves to a newer privacy epoch (off the record / resume): cancels everything from the old one. */
  setEpoch(epoch: number): void;
  epoch(): number;
  stats(): QueueStats;
  /** Resolves when nothing is pending or in flight. */
  idle(): Promise<void>;
};

const DEFAULT_MAX_SAMPLES = 4096;

export function createPerceptionQueue<P, R>(options: PerceptionQueueOptions<P, R>): PerceptionQueue<P> {
  const maxSamples = options.maxSamples ?? DEFAULT_MAX_SAMPLES;
  let epoch = options.epoch;
  let nextSeq = (options.lastFrameSeq ?? 0) + 1;
  let pending: PerceptionFrame<P> | null = null;
  let inFlight: { frame: PerceptionFrame<P>; controller: AbortController; cancelled: boolean } | null = null;
  let idleWaiters: Array<() => void> = [];
  const counts = { submitted: 0, sent: 0, coalesced: 0, applied: 0, staleDropped: 0, cancelled: 0, epochRejected: 0, failed: 0 };
  const frameToApplyMs: number[] = [];
  const requestMs: number[] = [];

  const sample = (list: number[], value: number): void => {
    list.push(value);
    if (list.length > maxSamples) list.shift();
  };

  const applier = createStateApplier<{ result: R; frame: PerceptionFrame<P> }>({
    currentEpoch: () => epoch,
    lastApplied: options.lastFrameSeq ?? 0,
    apply: ({ result, frame }) => {
      options.apply(result, frame);
      counts.applied += 1;
      sample(frameToApplyMs, options.now() - frame.captureTime);
    },
  });

  const settleIdle = (): void => {
    if (pending !== null || inFlight !== null) return;
    const waiters = idleWaiters;
    idleWaiters = [];
    for (const resolve of waiters) resolve();
  };

  const pump = (): void => {
    if (inFlight !== null || pending === null) return settleIdle();
    const frame = pending;
    pending = null;
    const slot = { frame, controller: new AbortController(), cancelled: false };
    inFlight = slot;
    counts.sent += 1;
    const started = options.now();
    // `send` may throw synchronously; Promise.resolve().then keeps both paths asynchronous and uniform.
    Promise.resolve()
      .then(() => options.send(frame, slot.controller.signal))
      .then(
        (result) => {
          sample(requestMs, options.now() - started);
          try {
            const fresh = !slot.cancelled && applier.offer(frame, { result, frame });
            if (!fresh) counts.staleDropped += 1;
          } catch (error) {
            // A throwing `apply` is a caller bug; report it rather than leave an unhandled rejection.
            counts.failed += 1;
            options.onError?.(error, frame);
          }
        },
        (error: unknown) => {
          if (slot.cancelled) counts.staleDropped += 1;
          else {
            counts.failed += 1;
            options.onError?.(error, frame);
          }
        },
      )
      .finally(() => {
        inFlight = null;
        pump();
      });
  };

  const cancelAll = (): void => {
    if (pending !== null) {
      counts.cancelled += 1;
      pending = null;
    }
    if (inFlight !== null && !inFlight.cancelled) {
      inFlight.cancelled = true;
      inFlight.controller.abort();
    }
    settleIdle();
  };

  return {
    submit(payload, captureTime, frameEpoch) {
      if (frameEpoch !== epoch) {
        counts.epochRejected += 1;
        return null;
      }
      const frame: PerceptionFrame<P> = { frameSeq: nextSeq, captureTime, epoch: frameEpoch, payload };
      nextSeq += 1;
      counts.submitted += 1;
      if (pending !== null) counts.coalesced += 1;
      pending = frame;
      pump();
      return frame;
    },
    cancelAll,
    setEpoch(next) {
      if (!Number.isInteger(next) || next <= epoch) throw new RangeError(`privacy epoch must increase (current ${epoch}, got ${next})`);
      cancelAll();
      epoch = next;
    },
    epoch: () => epoch,
    stats: () => ({
      ...counts,
      inFlight: inFlight === null ? 0 : 1,
      pendingFrameSeq: pending?.frameSeq ?? null,
      frameToApplyMs: [...frameToApplyMs],
      requestMs: [...requestMs],
    }),
    idle: () =>
      pending === null && inFlight === null ? Promise.resolve() : new Promise<void>((resolve) => idleWaiters.push(resolve)),
  };
}
