/**
 * CaseDesk DOM channel (plan §7.1): the app reports what the reviewer did as labelled
 * `source: "dom"` screen events. Events are batched and delivered in order, one request in flight
 * per session, after `idleMs` without new events or when `flush()` is called (before Save).
 *
 * Failure policy:
 * - a 409 (stale privacy epoch, stale frame, off the record) or any other refusal stops the channel
 *   for good: retrying cannot succeed and must not be attempted blindly; the UI shows the error;
 * - a network failure or 5xx keeps the events queued; the next `flush()` (or new event) retries them.
 *
 * Off the record (plan §7.8): `suspend()` drops every queued event and refuses new ones; a batch already
 * in flight that the server refuses because of the privacy transition is discarded, not fatal.
 * `resume(epoch)` stamps later events with the new privacy epoch.
 */
import type { ScreenEvent } from "@vashistha/core";
import { ActionIdSchema, FeatureIdSchema, type Value } from "@vashistha/core";
import { KYC_DOMAIN } from "@vashistha/core/domains/kyc";
import { ApiError, postEvents, type FetchFn } from "./api";

/** The contract's per-request ceiling (`PostEventsRequestSchema`). */
export const MAX_BATCH = 50;
export const DEFAULT_IDLE_MS = 250;

export type DomEventInput =
  | { kind: "navigate" }
  | { kind: "open_case"; caseId: string }
  | { kind: "field_change"; caseId: string; field: string; from: Value; to: Value }
  | { kind: "action"; caseId: string; action: string };

export type DomChannelStatus =
  | { state: "idle" }
  | { state: "sending"; pending: number }
  | { state: "retryable_error"; pending: number; error: ApiError }
  /** Off the record: nothing is captured or sent. */
  | { state: "paused" }
  | { state: "stopped"; error: ApiError };

type Timers = {
  set: (fn: () => void, ms: number) => unknown;
  clear: (handle: unknown) => void;
};

export type DomEventEmitterOptions = {
  sessionId: string;
  /** The session's privacy epoch; the server rejects events stamped with a stale one. */
  sessionEpoch: number;
  /** Highest frameSeq already delivered for this session (0 for a new session). */
  lastFrameSeq: number;
  fetch: FetchFn;
  idleMs?: number;
  now?: () => number;
  newId?: () => string;
  timers?: Timers;
};

export type DomEventEmitter = {
  /** Queues an event and returns it as it will be sent. Ignored (returns undefined) once the channel has stopped. */
  emit: (input: DomEventInput) => ScreenEvent | undefined;
  /** Resolves once every event emitted before the call has been delivered; rejects with the delivery error. */
  flush: () => Promise<void>;
  status: () => DomChannelStatus;
  /** Off the record: drop queued events and ignore new ones until `resume`. Pending `flush()` calls reject. */
  suspend: () => void;
  /** Back on the record: later events carry `epoch`. */
  resume: (epoch: number) => void;
  subscribe: (listener: (status: DomChannelStatus) => void) => () => void;
  dispose: () => void;
};

const CRITICAL_FIELDS = new Set<string>(KYC_DOMAIN.criticalFields);

/** Client-side `critical` flag: a change to one of the domain's critical fields. The server re-derives it. */
export function isCritical(input: DomEventInput): boolean {
  return input.kind === "field_change" && CRITICAL_FIELDS.has(input.field);
}

/** Network failures and server errors may succeed later; every other refusal is final. */
function isRetryable(error: ApiError): boolean {
  return error.kind === "network" || (error.kind === "http" && error.status >= 500);
}

function toError(error: unknown): ApiError {
  if (error instanceof ApiError) return error;
  return new ApiError("network", 0, "network_error", error instanceof Error ? error.message : undefined);
}

type Waiter = { seq: number; resolve: () => void; reject: (error: ApiError) => void };

export function createDomEventEmitter(options: DomEventEmitterOptions): DomEventEmitter {
  const idleMs = options.idleMs ?? DEFAULT_IDLE_MS;
  const now = options.now ?? Date.now;
  const newId = options.newId ?? (() => crypto.randomUUID());
  const timers: Timers = options.timers ?? {
    set: (fn, ms) => setTimeout(fn, ms),
    clear: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
  };

  const queue: ScreenEvent[] = [];
  const waiters: Waiter[] = [];
  const listeners = new Set<(status: DomChannelStatus) => void>();
  let nextSeq = options.lastFrameSeq + 1;
  let deliveredSeq = options.lastFrameSeq;
  let inFlight = false;
  /** Size of the batch in flight: it occupies the head of the queue until it settles. */
  let inFlightCount = 0;
  let idleTimer: unknown;
  let lastError: ApiError | undefined;
  let stopped: ApiError | undefined;
  let disposed = false;
  let epoch = options.sessionEpoch;
  let suspended = false;

  const status = (): DomChannelStatus => {
    if (stopped) return { state: "stopped", error: stopped };
    if (suspended) return { state: "paused" };
    if (lastError) return { state: "retryable_error", pending: queue.length, error: lastError };
    if (inFlight || queue.length > 0) return { state: "sending", pending: queue.length };
    return { state: "idle" };
  };
  const notify = (): void => {
    const current = status();
    for (const listener of listeners) listener(current);
  };

  const settleWaiters = (): void => {
    for (let i = waiters.length - 1; i >= 0; i -= 1) {
      const waiter = waiters[i];
      if (waiter && waiter.seq <= deliveredSeq) {
        waiters.splice(i, 1);
        waiter.resolve();
      }
    }
  };
  const rejectWaiters = (error: ApiError): void => {
    for (const waiter of waiters.splice(0)) waiter.reject(error);
  };

  const clearIdle = (): void => {
    if (idleTimer !== undefined) timers.clear(idleTimer);
    idleTimer = undefined;
  };

  const pump = (): void => {
    if (inFlight || stopped || disposed || suspended || queue.length === 0) return;
    clearIdle();
    const batch = queue.slice(0, MAX_BATCH);
    inFlight = true;
    inFlightCount = batch.length;
    notify();
    postEvents(options.fetch, options.sessionId, { events: batch }).then(
      () => {
        inFlight = false;
        inFlightCount = 0;
        queue.splice(0, batch.length);
        deliveredSeq = batch[batch.length - 1]?.frameSeq ?? deliveredSeq;
        lastError = undefined;
        settleWaiters();
        // Anything that queued up while this batch was in flight has already waited long enough.
        if (queue.length > 0 && !disposed) pump();
        else notify();
      },
      (raw: unknown) => {
        inFlight = false;
        inFlightCount = 0;
        const error = toError(raw);
        // Sent before a privacy transition and refused because of it: the events are simply not recorded.
        if (suspended || batch[0]?.sessionEpoch !== epoch) {
          queue.splice(0, batch.length);
          deliveredSeq = batch[batch.length - 1]?.frameSeq ?? deliveredSeq;
          settleWaiters();
          if (queue.length > 0 && !disposed) pump();
          else notify();
          return;
        }
        if (isRetryable(error)) lastError = error;
        else stopped = error;
        rejectWaiters(error);
        notify();
      },
    );
  };

  const emit = (input: DomEventInput): ScreenEvent | undefined => {
    if (stopped || disposed || suspended) return undefined;
    const event: ScreenEvent = {
      id: newId(),
      frameSeq: nextSeq,
      captureTime: now(),
      sessionEpoch: epoch,
      kind: input.kind,
      confidence: 1,
      source: "dom",
      critical: isCritical(input),
    };
    if (input.kind !== "navigate") event.caseId = input.caseId;
    if (input.kind === "field_change") {
      event.field = FeatureIdSchema.parse(input.field);
      event.from = input.from;
      event.to = input.to;
    }
    if (input.kind === "action") event.action = ActionIdSchema.parse(input.action);
    nextSeq += 1;
    queue.push(event);
    clearIdle();
    idleTimer = timers.set(() => {
      idleTimer = undefined;
      pump();
    }, idleMs);
    notify();
    return event;
  };

  const flush = (): Promise<void> => {
    if (stopped) return Promise.reject(stopped);
    if (suspended) return Promise.reject(new ApiError("http", 409, "off_record", "the session is off the record"));
    // The newest event not yet delivered (events dropped while off the record are no longer pending).
    const target = queue.at(-1)?.frameSeq;
    if (target === undefined || target <= deliveredSeq) return Promise.resolve();
    return new Promise<void>((resolve, reject) => {
      waiters.push({ seq: target, resolve, reject });
      pump();
    });
  };

  const suspend = (): void => {
    if (suspended || stopped || disposed) return;
    suspended = true;
    clearIdle();
    // The batch in flight (if any) stays at the head of the queue until it settles.
    queue.splice(inFlightCount);
    lastError = undefined;
    rejectWaiters(new ApiError("http", 409, "off_record", "the session went off the record"));
    notify();
  };

  const resume = (next: number): void => {
    if (stopped || disposed) return;
    epoch = next;
    if (!suspended) return;
    suspended = false;
    notify();
  };

  return {
    emit,
    flush,
    status,
    suspend,
    resume,
    subscribe: (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    dispose: () => {
      disposed = true;
      clearIdle();
      listeners.clear();
      rejectWaiters(new ApiError("network", 0, "channel_closed", "the event channel was closed"));
    },
  };
}
