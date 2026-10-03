/**
 * Off the record (plan §7.8), client side. Going off record mutes the microphone FIRST — synchronously,
 * before any network call — then tells every subscriber (DOM channel, utterance uploads, the gate,
 * perception) so they stop capturing and drop what is queued, and only then asks the server to advance
 * the privacy epoch. Resuming is the reverse: the server confirms a new epoch, subscribers resume with
 * it, then the microphone is unmuted.
 *
 * Failure policy: fail closed. If the server cannot be reached, the client stays off the record (mic
 * muted, nothing captured) and reconciles from the ledger; the UI offers a retry.
 */
import type { LedgerEntry } from "@vashistha/core";
import { parseLedgerPayload } from "@vashistha/core";
import { describeError, type FetchFn } from "../api";
import { readLedger } from "../session-state";
import { postOffRecord } from "./api";

/** Shown on the off-record banner; the only privacy claim the product makes about this mode. */
export const OFF_RECORD_CLAIM =
  "Off-record content is prevented from entering our evidence store; microphone and frame transmission are disabled while off the record. The trigger phrase itself may reach the voice provider.";

export type PrivacyBase = { offRecord: boolean; epoch: number };

export type PrivacyState = PrivacyBase & {
  /** A transition is waiting for the server. */
  pending: boolean;
  /** The server has not confirmed the latest transition; the client stays off the record. */
  error: string | undefined;
};

export type PrivacyListener = (state: PrivacyState) => void;

export type PrivacyControllerOptions = {
  initial: PrivacyBase;
  /** Mutes or unmutes the microphone. Called synchronously, before any network call; must not throw. */
  setMicMuted: (muted: boolean) => void;
  /** POST off-record; resolves with the server's new state. */
  transition: (offRecord: boolean) => Promise<PrivacyBase>;
  /** The server's current state, read back when a transition failed (it may have been applied anyway). */
  readServerState: () => Promise<PrivacyBase>;
};

export type PrivacyController = {
  state: () => PrivacyState;
  /** Called synchronously on every change; returns an unsubscribe function. */
  subscribe: (listener: PrivacyListener) => () => void;
  /** Mic off now, capture stops now, then the server. Retries the server call if it failed before. */
  goOffRecord: () => Promise<void>;
  /** Server first (new epoch), then capture resumes, then the mic is unmuted. */
  resume: () => Promise<void>;
};

/** The session's privacy state as the ledger records it: the last privacy transition wins. */
export function privacyFromLedger(entries: readonly LedgerEntry[]): PrivacyBase {
  let offRecord = false;
  let epoch = 0;
  for (const entry of entries) {
    epoch = Math.max(epoch, entry.privacyEpoch);
    if (entry.kind === "privacy.off_record") {
      epoch = Math.max(epoch, parseLedgerPayload(entry, "privacy.off_record").privacyEpoch);
      offRecord = true;
    } else if (entry.kind === "privacy.on_record") {
      epoch = Math.max(epoch, parseLedgerPayload(entry, "privacy.on_record").privacyEpoch);
      offRecord = false;
    }
  }
  return { offRecord, epoch };
}

export function createPrivacyController(options: PrivacyControllerOptions): PrivacyController {
  let state: PrivacyState = { ...options.initial, pending: false, error: undefined };
  const listeners = new Set<PrivacyListener>();

  const set = (next: Partial<PrivacyState>): void => {
    state = { ...state, ...next };
    for (const listener of [...listeners]) listener(state);
  };

  /** After a failed call: adopt the server's state when it already matches the wanted one. */
  async function reconcile(wanted: boolean, error: unknown): Promise<void> {
    try {
      const server = await options.readServerState();
      if (server.offRecord === wanted) {
        set({ ...server, pending: false, error: undefined });
        return;
      }
    } catch {
      // The original error is the one worth showing.
    }
    set({ pending: false, error: describeError(error) });
  }

  return {
    state: () => state,
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    async goOffRecord() {
      if (state.pending || (state.offRecord && state.error === undefined)) return;
      options.setMicMuted(true);
      set({ offRecord: true, pending: true, error: undefined });
      try {
        const confirmed = await options.transition(true);
        set({ offRecord: true, epoch: confirmed.epoch, pending: false, error: undefined });
      } catch (error) {
        await reconcile(true, error);
      }
    },
    async resume() {
      if (state.pending || !state.offRecord) return;
      set({ pending: true });
      try {
        const confirmed = await options.transition(false);
        set({ offRecord: false, epoch: confirmed.epoch, pending: false, error: undefined });
      } catch (error) {
        await reconcile(false, error);
      }
      if (!state.offRecord) options.setMicMuted(false);
    },
  };
}

/** The HTTP-backed transition and read-back for a session. */
export function privacyServer(fetchFn: FetchFn, sessionId: string): Pick<PrivacyControllerOptions, "transition" | "readServerState"> {
  return {
    transition: async (offRecord) => {
      const response = await postOffRecord(fetchFn, sessionId, offRecord);
      return { offRecord: response.offRecord, epoch: response.privacyEpoch };
    },
    readServerState: async () => privacyFromLedger(await readLedger(fetchFn, sessionId)),
  };
}
