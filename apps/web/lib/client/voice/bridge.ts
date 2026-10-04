/**
 * Framework-free wiring between the ElevenLabs conversation callbacks and the rest of the system:
 *
 * - VAD scores and agent mode feed the gate;
 * - final expert transcripts (`onMessage` role "user") are posted as utterances, tagged with the
 *   question the agent just asked, the privacy epoch they were captured in and (non-English sessions)
 *   the session's language; agent turns are posted
 *   as agent utterances (never evidence);
 * - control messages (`⟦ctl:…⟧`, plan §7.2 provenance) are never posted and never shown;
 * - an expert turn that is an off-record phrase (plan §7.8) is never posted or shown either: it goes off
 *   the record at once (the server's `set_off_record` tool call follows; going off is idempotent);
 * - nothing is captured or posted while off the record, and queued uploads are dropped on going off.
 */
import { isOffRecordPhrase, parseControlMessage, type ExpertLanguage } from "@vashistha/core";
import { describeError, type FetchFn } from "../api";
import { postAgentUtterance, postUtterance } from "./api";
import type { PrivacyBase } from "./privacy";

export const MAX_UTTERANCE_CHARS = 4000;
const MAX_TRANSCRIPT_TURNS = 100;

/** True for a gate control message or any text carrying one; such text is never evidence or UI. */
export function isControlText(text: string): boolean {
  return parseControlMessage(text) !== null || text.includes("⟦ctl:");
}

export type TranscriptTurn = {
  id: number;
  role: "user" | "agent";
  text: string;
  /** Epoch ms when the turn arrived. */
  at: number;
  questionId: string | undefined;
};

export type UploadStatus = { pending: number; failed: number; lastError: string | undefined };

export type BridgeGate = {
  vad: (score: number) => void;
  agentSpeaking: (speaking: boolean) => void;
  setVoiceLive: (live: boolean) => void;
};

export type BridgeOptions = {
  sessionId: string;
  fetch: FetchFn;
  now: () => number;
  gate: BridgeGate;
  privacy: () => PrivacyBase;
  /** VAD score at or above which the expert counts as speaking (the gate's threshold). */
  vadThreshold: number;
  /** The expert said an off-record phrase (its text is dropped, not recorded). */
  onOffRecordPhrase: () => void;
  /**
   * The language the voice session was started in (its ASR language), sent with each utterance as a
   * prior for the server's language detection (plan §7.11). Omitted: English.
   */
  language?: ExpertLanguage;
};

export type ConversationBridge = {
  connected: (conversationId: string) => void;
  disconnected: () => void;
  vad: (score: number) => void;
  mode: (mode: "speaking" | "listening") => void;
  message: (message: { message: string; role: "user" | "agent" }) => void;
  /** The gate authorized `questionId` and sent its control message: the next agent turn asks it. */
  asked: (questionId: string) => void;
  /** Off the record: drop every upload that has not started. */
  cancelQueued: () => void;
  conversationId: () => string | undefined;
  transcript: () => readonly TranscriptTurn[];
  uploads: () => UploadStatus;
  subscribe: (listener: () => void) => () => void;
};

type Job = { epoch: number; run: () => Promise<void> };

export function createConversationBridge(options: BridgeOptions): ConversationBridge {
  const { gate, now } = options;
  const listeners = new Set<() => void>();
  let conversation: { id: string; startedAt: number } | undefined;
  let speaking = false;
  let speechStartedAt: number | undefined;
  /** The question the gate just had asked: tagged on the agent turn that asks it and the answer after it. */
  let asked: { questionId: string; agentSpoke: boolean } | undefined;
  let transcript: readonly TranscriptTurn[] = [];
  let nextTurnId = 1;
  const queue: Job[] = [];
  let running = false;
  let uploads: UploadStatus = { pending: 0, failed: 0, lastError: undefined };

  const notify = (): void => {
    for (const listener of [...listeners]) listener();
  };
  const setUploads = (next: Partial<UploadStatus>): void => {
    uploads = { ...uploads, ...next };
    notify();
  };

  const onRecordIn = (epoch: number): boolean => {
    const privacy = options.privacy();
    return !privacy.offRecord && privacy.epoch === epoch;
  };

  function pump(): void {
    if (running) return;
    const job = queue.shift();
    if (!job) return;
    // Captured in an earlier epoch (or now off the record): it must not reach the evidence store.
    if (!onRecordIn(job.epoch)) {
      setUploads({ pending: queue.length + (running ? 1 : 0) });
      pump();
      return;
    }
    running = true;
    job.run().then(
      () => {
        running = false;
        setUploads({ pending: queue.length });
        pump();
      },
      (error: unknown) => {
        running = false;
        setUploads({ pending: queue.length, failed: uploads.failed + 1, lastError: describeError(error) });
        pump();
      },
    );
  }

  const enqueue = (job: Job): void => {
    queue.push(job);
    setUploads({ pending: queue.length + (running ? 1 : 0) });
    pump();
  };

  const addTurn = (role: TranscriptTurn["role"], text: string, questionId: string | undefined): void => {
    transcript = [...transcript, { id: nextTurnId++, role, text, at: now(), questionId }].slice(-MAX_TRANSCRIPT_TURNS);
    notify();
  };

  return {
    connected(conversationId) {
      conversation = { id: conversationId, startedAt: now() };
      speaking = false;
      speechStartedAt = undefined;
      gate.setVoiceLive(true);
      notify();
    },
    disconnected() {
      conversation = undefined;
      asked = undefined;
      gate.setVoiceLive(false);
      notify();
    },
    vad(score) {
      gate.vad(score);
      const isSpeaking = score >= options.vadThreshold;
      if (isSpeaking && !speaking) speechStartedAt ??= now();
      speaking = isSpeaking;
    },
    mode(mode) {
      gate.agentSpeaking(mode === "speaking");
    },
    message({ message, role }) {
      const text = message.trim();
      if (text === "" || isControlText(text) || conversation === undefined) return;
      if (role === "user" && isOffRecordPhrase(text)) {
        speechStartedAt = undefined;
        options.onOffRecordPhrase();
        return;
      }
      const privacy = options.privacy();
      if (privacy.offRecord) return;
      const { id: conversationId, startedAt } = conversation;
      const epoch = privacy.epoch;

      if (role === "agent") {
        const questionId = asked !== undefined && !asked.agentSpoke ? asked.questionId : undefined;
        if (asked !== undefined) asked = { ...asked, agentSpoke: true };
        addTurn("agent", text, questionId);
        enqueue({
          epoch,
          run: () =>
            postAgentUtterance(options.fetch, options.sessionId, {
              conversationId,
              text: text.slice(0, MAX_UTTERANCE_CHARS),
              ...(questionId !== undefined && { questionId }),
            }),
        });
        return;
      }

      const questionId = asked?.agentSpoke ? asked.questionId : undefined;
      if (questionId !== undefined) asked = undefined;
      const t1Ms = Math.max(0, now() - startedAt);
      const t0Ms = speechStartedAt === undefined ? t1Ms : Math.min(t1Ms, Math.max(0, speechStartedAt - startedAt));
      speechStartedAt = undefined;
      addTurn("user", text, questionId);
      enqueue({
        epoch,
        run: async () => {
          await postUtterance(options.fetch, options.sessionId, {
            conversationId,
            text: text.slice(0, MAX_UTTERANCE_CHARS),
            t0Ms,
            t1Ms,
            ...(questionId !== undefined && { questionId }),
            privacyEpoch: epoch,
            ...(options.language !== undefined && options.language !== "en" && { language: options.language }),
          });
        },
      });
    },
    asked(questionId) {
      asked = { questionId, agentSpoke: false };
    },
    cancelQueued() {
      queue.length = 0;
      speechStartedAt = undefined;
      setUploads({ pending: running ? 1 : 0 });
    },
    conversationId: () => conversation?.id,
    transcript: () => transcript,
    uploads: () => uploads,
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
}
