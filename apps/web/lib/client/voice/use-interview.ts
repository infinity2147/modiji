"use client";

/**
 * The live interview/tutor loop for one CaseDesk session: the ElevenLabs conversation (expert →
 * interviewer agent, novice → tutor agent), the browser speech gate, off-record control and the ledger
 * tail the judge view reads. Must be rendered inside `ConversationProvider`.
 *
 * Everything with timers or network (gate polling, ledger tail) is created in effects, never during
 * render, so server rendering stays inert.
 */
import { createContext, useCallback, useContext, useEffect, useRef, useState, useSyncExternalStore } from "react";
import { useConversation, useConversationClientTool } from "@elevenlabs/react";
import { z } from "zod";
import { DEFAULT_GATE_CONFIG, SET_OFF_RECORD_TOOL, systemClock, type AgentRole } from "@vashistha/core";
import type { SessionMode } from "../../contracts/casedesk";
import { describeError, type FetchFn } from "../api";
import { createGateSession, type GateSession, type GateSnapshot } from "../gate/gate-session";
import { createLedgerTail, type LedgerTail, type LedgerTailState } from "../judge/ledger-tail";
import { fetchVoiceToken } from "./api";
import { createConversationBridge, type ConversationBridge, type TranscriptTurn, type UploadStatus } from "./bridge";
import { createPrivacyController, privacyServer, type PrivacyBase, type PrivacyController, type PrivacyState } from "./privacy";
import { browserCueDom, createCueScheduler, type CueResult } from "./question-cues";

const browserFetch: FetchFn = (input, init) => fetch(input, init);

export const AGENT_FOR_MODE: Record<SessionMode, AgentRole> = { expert: "interviewer", novice: "tutor" };

export type VoiceStatus =
  | { state: "idle" }
  | { state: "requesting" }
  | { state: "connecting" }
  | { state: "connected"; conversationId: string }
  | { state: "not_configured"; missing: readonly string[] }
  | { state: "error"; message: string }
  | { state: "ended"; reason: string };

/** What the DOM channel must do when the privacy state changes. */
export type CaptureControl = { suspend: () => void; resume: (epoch: number) => void };

/** Gate sensing entry points for CaseDesk (no-ops until the loop is running). */
export type GateSensors = {
  typing: () => void;
  screenMotion: () => void;
  caseOpened: () => void;
  edited: () => void;
  committed: () => void;
};

export type InterviewLoop = {
  agent: AgentRole;
  voice: VoiceStatus;
  /** Why the conversation cannot start now, if it cannot (shown instead of a usable Connect button). */
  startBlocked: string | undefined;
  micMuted: boolean;
  agentSpeaking: boolean;
  connect: () => void;
  disconnect: () => void;
  transcript: readonly TranscriptTurn[];
  uploads: UploadStatus;
  gate: GateSnapshot | null;
  sensors: GateSensors;
  /** The off-record signal (perception and other capture modules subscribe to it); null until loaded. */
  privacy: PrivacyController | null;
  privacyState: PrivacyState | null;
  ledger: LedgerTailState;
  /** The UI cue for the last question spoken (field highlighted, gap shown), if it had one. */
  cue: CueResult | null;
};

/**
 * `set_off_record` client tool parameters (agents/*.json `clientTools`). The custom LLM calls it, with
 * `{offRecord: true}` and no speech, when the expert says an off-record phrase; the bridge has usually
 * gone off the record on the transcript already (going off is idempotent). Resuming by voice is
 * impossible by design — the microphone is muted while off the record — so `offRecord: false` is refused.
 */
const SetOffRecordParamsSchema = z.object({ offRecord: z.boolean() });

const EMPTY_TRANSCRIPT: readonly TranscriptTurn[] = [];
const NO_UPLOADS: UploadStatus = { pending: 0, failed: 0, lastError: undefined };
const NO_LEDGER: LedgerTailState = { entries: [], caughtUp: false, error: undefined };
const noop = (): void => {};
const nothing = (): (() => void) => noop;

type Loop = { gate: GateSession; bridge: ConversationBridge; tail: LedgerTail };

/** useSyncExternalStore over a store that may not exist yet. */
function useOptionalStore<T>(
  store: { subscribe: (listener: () => void) => () => void; read: () => T } | null,
  fallback: T,
): T {
  return useSyncExternalStore(
    store?.subscribe ?? nothing,
    store?.read ?? (() => fallback),
    () => fallback,
  );
}

export function useInterviewLoop(options: {
  sessionId: string;
  mode: SessionMode;
  /** The session's privacy state from its ledger; undefined while loading. */
  privacyInit: PrivacyBase | undefined;
  capture: CaptureControl;
  /**
   * Screen capture is active. An expert interview may not start without it: a confirmed rule needs a
   * redacted frame of the screen at the moment of the expert's quote. The tutor does not need it.
   */
  screenShared: boolean;
}): InterviewLoop {
  const { sessionId, mode, privacyInit, screenShared } = options;
  const agent = AGENT_FOR_MODE[mode];
  const [loop, setLoop] = useState<Loop | null>(null);
  const [privacy, setPrivacy] = useState<PrivacyController | null>(null);
  const [voice, setVoice] = useState<VoiceStatus>({ state: "idle" });
  const [cue, setCue] = useState<CueResult | null>(null);
  const [cues] = useState(() => createCueScheduler({ dom: browserCueDom, now: systemClock.now, onCue: setCue }));
  const loopRef = useRef<Loop | null>(null);
  const privacyRef = useRef<PrivacyController | null>(null);
  const captureRef = useRef(options.capture);

  const conversation = useConversation({
    onConnect: ({ conversationId }) => {
      // Defence in depth: connecting is disabled off the record, but never let a mic go live then.
      if (privacyRef.current?.state().offRecord) muteMic(true);
      loopRef.current?.bridge.connected(conversationId);
      setVoice({ state: "connected", conversationId });
    },
    onDisconnect: (details) => {
      cues.reset();
      loopRef.current?.bridge.disconnected();
      setVoice(
        details.reason === "error"
          ? { state: "error", message: details.message }
          : { state: "ended", reason: details.reason === "agent" ? "The agent ended the conversation" : "Disconnected" },
      );
    },
    onError: (message) => setVoice({ state: "error", message }),
    onMessage: (message) => loopRef.current?.bridge.message(message),
    onVadScore: ({ vadScore }) => loopRef.current?.bridge.vad(vadScore),
    onModeChange: ({ mode: agentMode }) => {
      loopRef.current?.bridge.mode(agentMode);
      cues.agentMode(agentMode);
    },
  });
  const conversationRef = useRef(conversation);
  useEffect(() => {
    conversationRef.current = conversation;
  });

  /** Mutes or unmutes the live microphone; with no conversation there is no microphone to mute. */
  function muteMic(muted: boolean): void {
    try {
      conversationRef.current.setMuted(muted);
    } catch {
      // "No active conversation": nothing is capturing audio.
    }
  }

  useEffect(() => {
    captureRef.current = options.capture;
  });

  // Gate, conversation bridge and ledger tail: one set per loaded session.
  const loaded = privacyInit !== undefined;
  useEffect(() => {
    if (!loaded) return;
    // The bridge and the gate call each other only from callbacks, after both exist.
    const bridge = createConversationBridge({
      sessionId,
      fetch: browserFetch,
      now: systemClock.now,
      gate: {
        vad: (score) => gate.vad(score),
        agentSpeaking: (speaking) => gate.agentSpeaking(speaking),
        setVoiceLive: (live) => gate.setVoiceLive(live),
      },
      privacy: () => privacyRef.current?.state() ?? { offRecord: true, epoch: -1 },
      vadThreshold: DEFAULT_GATE_CONFIG.vadSpeakingThreshold,
      onOffRecordPhrase: () => void privacyRef.current?.goOffRecord(),
    });
    const gate = createGateSession({
      sessionId,
      mode: agent,
      fetch: browserFetch,
      clock: systemClock,
      sendControlMessage: (text) => conversationRef.current.sendUserMessage(text),
      holdAgent: () => conversationRef.current.sendUserActivity(),
      onAsked: (asked) => {
        bridge.asked(asked.questionId);
        cues.armed(asked);
      },
    });
    const tail = createLedgerTail({ sessionId, fetch: browserFetch, setTimer: systemClock.setTimer });
    const next = { gate, bridge, tail };
    loopRef.current = next;
    setLoop(next);
    return () => {
      loopRef.current = null;
      gate.dispose();
      tail.dispose();
      try {
        conversationRef.current.endSession();
      } catch {
        // Already ended.
      }
    };
  }, [sessionId, agent, loaded, cues]);

  // The privacy controller exists once the session's privacy state is known.
  const offRecordAtLoad = privacyInit?.offRecord;
  const epochAtLoad = privacyInit?.epoch;
  useEffect(() => {
    if (offRecordAtLoad === undefined || epochAtLoad === undefined) return;
    const controller = createPrivacyController({
      initial: { offRecord: offRecordAtLoad, epoch: epochAtLoad },
      setMicMuted: muteMic,
      ...privacyServer(browserFetch, sessionId),
    });
    privacyRef.current = controller;
    setPrivacy(controller);
    return () => {
      privacyRef.current = null;
    };
  }, [sessionId, offRecordAtLoad, epochAtLoad]);

  // Every privacy change reaches every capture path (and the gate) synchronously.
  useEffect(() => {
    if (!privacy || !loop) return;
    const apply = (state: PrivacyState): void => {
      loop.gate.setOffRecord(state.offRecord);
      if (state.offRecord) {
        captureRef.current.suspend();
        loop.bridge.cancelQueued();
      } else captureRef.current.resume(state.epoch);
      loop.tail.poke();
    };
    apply(privacy.state());
    return privacy.subscribe(apply);
  }, [privacy, loop]);

  useConversationClientTool(SET_OFF_RECORD_TOOL, (params: Record<string, unknown>) => {
    const parsed = SetOffRecordParamsSchema.safeParse(params);
    if (!parsed.success) throw new Error(`${SET_OFF_RECORD_TOOL} expects { offRecord: boolean }`);
    if (!parsed.data.offRecord) return "Not resumed: going back on the record is only possible with the on-screen button.";
    const controller = privacyRef.current;
    if (!controller) throw new Error("the session is still loading");
    void controller.goOffRecord();
    return "Off the record: the microphone is muted and capture has stopped.";
  });

  const privacyState = useOptionalStore(privacy && { subscribe: privacy.subscribe, read: privacy.state }, null);
  const startBlocked =
    privacyState === null
      ? "Loading the session…"
      : privacyState.offRecord
        ? "Off the record: resume the record to start voice"
        : agent === "interviewer" && !screenShared
          ? "Share your screen to start the interview"
          : undefined;
  const startBlockedRef = useRef(startBlocked);
  useEffect(() => {
    startBlockedRef.current = startBlocked;
  });

  const connect = useCallback(() => {
    if (privacyRef.current?.state().offRecord !== false || startBlockedRef.current !== undefined) return;
    setVoice({ state: "requesting" });
    fetchVoiceToken(browserFetch, agent).then(
      (result) => {
        if (result.kind === "not_configured") {
          setVoice({ state: "not_configured", missing: result.missing });
          return;
        }
        setVoice({ state: "connecting" });
        conversationRef.current.startSession({
          conversationToken: result.token.token,
          customLlmExtraBody: { sessionId },
        });
      },
      (error: unknown) => setVoice({ state: "error", message: describeError(error) }),
    );
  }, [agent, sessionId]);

  const disconnect = useCallback(() => {
    conversationRef.current.endSession();
  }, []);

  const gate = useOptionalStore(loop && { subscribe: loop.gate.subscribe, read: loop.gate.snapshot }, null);
  const transcript = useOptionalStore(loop && { subscribe: loop.bridge.subscribe, read: loop.bridge.transcript }, EMPTY_TRANSCRIPT);
  const uploads = useOptionalStore(loop && { subscribe: loop.bridge.subscribe, read: loop.bridge.uploads }, NO_UPLOADS);
  const ledger = useOptionalStore(loop && { subscribe: loop.tail.subscribe, read: loop.tail.state }, NO_LEDGER);

  const sensors: GateSensors = {
    typing: () => loopRef.current?.gate.typing(),
    screenMotion: () => loopRef.current?.gate.screenMotion(),
    caseOpened: () => loopRef.current?.gate.caseOpened(),
    edited: () => loopRef.current?.gate.edited(),
    committed: () => {
      loopRef.current?.gate.committed();
      loopRef.current?.tail.poke();
    },
  };

  return {
    agent,
    voice,
    startBlocked,
    micMuted: conversation.isMuted,
    agentSpeaking: conversation.isSpeaking,
    connect,
    disconnect,
    transcript,
    uploads,
    gate,
    sensors,
    privacy,
    privacyState,
    ledger,
    cue,
  };
}

/** The off-record signal for modules below the workspace (perception subscribes here). */
export const PrivacyContext = createContext<PrivacyController | null>(null);

export function usePrivacyController(): PrivacyController | null {
  return useContext(PrivacyContext);
}
