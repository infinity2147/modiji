/**
 * Framework-free wiring between the ElevenLabs conversation callbacks and the rest of the system:
 *
 * - VAD scores, agent mode and the arrival of transcripts (tentative and final: proof the expert
 *   spoke, and a final one closes their turn at the provider) feed the gate;
 * - voice is live for the gate (it may send control messages) only once the conversation is connected
 *   AND the agent has initialised it (`conversation_initiation_metadata`, see `initialised`);
 * - final expert transcripts (`onMessage` role "user") are posted as utterances, tagged with the
 *   question the agent asked last before the expert began that segment — every segment until the
 *   agent's next turn (an answer often arrives in several) — the privacy epoch they were captured in
 *   and (non-English sessions) the session's language; agent turns are posted as agent utterances
 *   (never evidence);
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
  localSpeech: (speaking: boolean) => void;
  /** The provider transcribed the expert: `final` for a finished user turn, else a tentative transcript. */
  transcript: (final: boolean) => void;
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
  /**
   * Schedules the fallback for an agent whose initiation never arrives (`INITIATION_FALLBACK_MS`). Omitted:
   * no fallback, voice stays not live until `initialised`.
   */
  setTimer?: (fn: () => void, delayMs: number) => () => void;
};

/**
 * Defence in depth: should the agent's `conversation_initiation_metadata` never be reported, voice turns live
 * this long after connecting anyway (live runs: it arrived ≈250 ms after the browser's initiation data, every time).
 */
export const INITIATION_FALLBACK_MS = 5000;

export type ConversationBridge = {
  connected: (conversationId: string) => void;
  /**
   * The agent has initialised the conversation (`conversation_initiation_metadata`, the SDK's
   * `onConversationMetadata`): only from now may the gate send it a control message. Over WebRTC the SDK
   * reports `onConnect` as soon as the browser has published its own initiation data, before the agent has
   * answered it (≈250 ms later in every live run), and a control message sent into that window can be lost
   * before the agent's LLM ever sees it. CaseDesk questions only become askable seconds after connecting, but a
   * debrief turn is already waiting when Talk connects: the gate authorised it and sent its control message in
   * the same tick as onConnect, and the interviewer never spoke.
   */
  initialised: () => void;
  disconnected: () => void;
  vad: (score: number) => void;
  /** The browser's own microphone detector: when the expert started speaking (it hears speech the VAD misses, and earlier). */
  localSpeech: (speaking: boolean) => void;
  /** A tentative transcript of the expert arrived (the provider's ASR is mid-turn). */
  tentative: () => void;
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

/** An agent turn: when its audio began, and the question it asked (every agent turn is an authorized question). */
type AgentTurn = { questionId: string; startedAt: number; textPosted: boolean };

const MAX_AGENT_TURNS = 20;
/**
 * A segment starts at the first onset since the last transcript — unless that speech ended this long
 * before the next onset with nothing transcribed (a cough, a key click): then the next onset starts it.
 */
const UNTRANSCRIBED_ONSET_MS = 3000;

export function createConversationBridge(options: BridgeOptions): ConversationBridge {
  const { gate, now } = options;
  const listeners = new Set<() => void>();
  let conversation: { id: string; startedAt: number } | undefined;
  /** The agent has initialised the current conversation (see `initialised`). */
  let agentReady = false;
  let cancelFallback: (() => void) | null = null;
  const stopFallback = (): void => {
    cancelFallback?.();
    cancelFallback = null;
  };
  let speaking = false;
  let localSpeaking = false;
  let agentSpeaking = false;
  let speechStartedAt: number | undefined;
  /** When both level channels last fell silent. */
  let silentSince: number | undefined;
  /** The question whose control message went out; its agent turn has not begun yet. */
  let armed: string | undefined;
  /** Agent turns, oldest first: a segment answers the latest one that began before the expert started it. */
  let turns: readonly AgentTurn[] = [];
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

  /** A level channel changed: track when the current segment's speech began and when it last went quiet. */
  const level = (wasSpeaking: boolean): void => {
    const isSpeaking = speaking || localSpeaking;
    const t = now();
    if (isSpeaking && !wasSpeaking) {
      if (speechStartedAt === undefined || (silentSince !== undefined && t - silentSince > UNTRANSCRIBED_ONSET_MS)) speechStartedAt = t;
      silentSince = undefined;
    } else if (!isSpeaking && wasSpeaking) silentSince = t;
  };

  const addTurn = (role: TranscriptTurn["role"], text: string, questionId: string | undefined): void => {
    transcript = [...transcript, { id: nextTurnId++, role, text, at: now(), questionId }].slice(-MAX_TRANSCRIPT_TURNS);
    notify();
  };

  return {
    connected(conversationId) {
      conversation = { id: conversationId, startedAt: now() };
      speaking = false;
      localSpeaking = false;
      agentSpeaking = false;
      speechStartedAt = undefined;
      silentSince = undefined;
      // The agent's initiation metadata is delivered after the SDK's onConnect; should it ever come first, it counts.
      stopFallback();
      if (agentReady) gate.setVoiceLive(true);
      else if (options.setTimer !== undefined)
        cancelFallback = options.setTimer(() => {
          cancelFallback = null;
          if (conversation?.id !== conversationId || agentReady) return;
          console.warn(`voice: the agent's conversation initiation was not reported within ${INITIATION_FALLBACK_MS} ms; treating it as ready`);
          agentReady = true;
          gate.setVoiceLive(true);
        }, INITIATION_FALLBACK_MS);
      notify();
    },
    initialised() {
      stopFallback();
      if (agentReady) return;
      agentReady = true;
      if (conversation !== undefined) gate.setVoiceLive(true);
    },
    disconnected() {
      stopFallback();
      conversation = undefined;
      agentReady = false;
      armed = undefined;
      turns = [];
      gate.setVoiceLive(false);
      notify();
    },
    vad(score) {
      gate.vad(score);
      const wasSpeaking = speaking || localSpeaking;
      speaking = score >= options.vadThreshold;
      level(wasSpeaking);
    },
    localSpeech(isSpeaking) {
      gate.localSpeech(isSpeaking);
      const wasSpeaking = speaking || localSpeaking;
      localSpeaking = isSpeaking;
      level(wasSpeaking);
    },
    tentative() {
      if (conversation === undefined) return;
      speechStartedAt ??= now();
      gate.transcript(false);
    },
    mode(mode) {
      const isSpeaking = mode === "speaking";
      gate.agentSpeaking(isSpeaking);
      // A new agent turn begins only with an authorized question; audio gaps inside one turn do not start another.
      if (isSpeaking && !agentSpeaking && armed !== undefined) {
        turns = [...turns, { questionId: armed, startedAt: now(), textPosted: false }].slice(-MAX_AGENT_TURNS);
        armed = undefined;
      }
      agentSpeaking = isSpeaking;
    },
    message({ message, role }) {
      if (conversation === undefined) return;
      const text = message.trim();
      // A finished user turn at the provider, whatever its words: the gate stops waiting for it.
      if (role === "user" && !isControlText(text)) gate.transcript(true);
      if (text === "" || isControlText(text)) return;
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
        const turn = turns.at(-1);
        const questionId = turn !== undefined && !turn.textPosted ? turn.questionId : undefined;
        if (turn !== undefined) turns = [...turns.slice(0, -1), { ...turn, textPosted: true }];
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

      const begun = speechStartedAt ?? now();
      const questionId = turns.findLast((turn) => turn.startedAt <= begun)?.questionId;
      const t1Ms = Math.max(0, now() - startedAt);
      const t0Ms = Math.min(t1Ms, Math.max(0, begun - startedAt));
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
      armed = questionId;
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
