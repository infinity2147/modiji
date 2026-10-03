/**
 * Live tail of a session's ledger (`GET /api/sessions/:id/ledger?after=`), shared by the event ticker
 * and the compliance strip. One request at a time; each page continues after the last sequence seen.
 * The ledger is append-only, so the accumulated entries are exactly the ledger's prefix.
 */
import type { LedgerEntry } from "@vashistha/core";
import { LEDGER_PAGE_MAX } from "../../contracts/ledger";
import { describeError, fetchLedgerPage, type FetchFn } from "../api";

export const LEDGER_POLL_MS = 1000;
const LEDGER_RETRY_MS = 5000;

export type LedgerTailState = {
  entries: readonly LedgerEntry[];
  /** True once the whole existing ledger has been read. */
  caughtUp: boolean;
  error: string | undefined;
};

export type LedgerTail = {
  state: () => LedgerTailState;
  subscribe: (listener: () => void) => () => void;
  /** Reads now instead of at the next tick (e.g. right after an action the user is watching for). */
  poke: () => void;
  dispose: () => void;
};

export type LedgerTailOptions = {
  sessionId: string;
  fetch: FetchFn;
  setTimer: (fn: () => void, ms: number) => () => void;
  pollMs?: number;
};

export function createLedgerTail(options: LedgerTailOptions): LedgerTail {
  const pollMs = options.pollMs ?? LEDGER_POLL_MS;
  const listeners = new Set<() => void>();
  let state: LedgerTailState = { entries: [], caughtUp: false, error: undefined };
  let inFlight = false;
  let disposed = false;
  let cancel: (() => void) | null = null;

  const schedule = (ms: number): void => {
    cancel?.();
    cancel = disposed ? null : options.setTimer(read, ms);
  };

  function read(): void {
    cancel = null;
    if (disposed || inFlight) return;
    inFlight = true;
    const after = state.entries.at(-1)?.sequence;
    fetchLedgerPage(options.fetch, options.sessionId, after, LEDGER_PAGE_MAX).then(
      ({ entries }) => {
        inFlight = false;
        if (disposed) return;
        const full = entries.length === LEDGER_PAGE_MAX;
        if (entries.length > 0 || state.error !== undefined || (!full && !state.caughtUp)) {
          state = { entries: [...state.entries, ...entries], caughtUp: !full, error: undefined };
          for (const listener of [...listeners]) listener();
        }
        schedule(full ? 0 : pollMs);
      },
      (error: unknown) => {
        inFlight = false;
        if (disposed) return;
        state = { ...state, error: describeError(error) };
        for (const listener of [...listeners]) listener();
        schedule(LEDGER_RETRY_MS);
      },
    );
  }

  read();
  return {
    state: () => state,
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    poke() {
      if (!inFlight) schedule(0);
    },
    dispose() {
      disposed = true;
      cancel?.();
      listeners.clear();
    },
  };
}
