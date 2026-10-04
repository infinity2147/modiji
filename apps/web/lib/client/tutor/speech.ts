"use client";

/**
 * Spoken coaching for the trainee with no setup: the browser's own voice (Web Speech API) reads the
 * predict-then-reveal result and the tutor's stop-rule warnings aloud. The ElevenLabs tutor agent stays
 * optional: while it is connected it speaks interventions itself, so the browser voice leaves those to
 * it (the caller decides; see `NoviceReview`). Text builders are pure; the speaker is framework-free
 * and tested against a fake `speechSynthesis`; `useTutorVoice` binds one shared speaker to React.
 */
import { useEffect, useSyncExternalStore } from "react";
import type { ExpertQuoteView, InterventionView } from "../../contracts/tutor";
import type { RevealModel } from "./view";

/** At most this many expert quotes are read after the verdict: the rest stay on screen. */
const MAX_SPOKEN_QUOTES = 2;

/** What can be said aloud of a quote: the words themselves in English, else their English translation, else nothing. */
export function speakableQuote(quote: ExpertQuoteView): string | undefined {
  if (quote.language === undefined || quote.language === "en") return quote.text;
  return quote.translation;
}

/** The reveal, as the coach says it: the verdict, then the deciding rules in the expert's words. */
export function revealSpeech(model: RevealModel): string {
  const quotes = [...new Set(model.rules.map((r) => speakableQuote(r.quote)).filter((q) => q !== undefined))].slice(0, MAX_SPOKEN_QUOTES);
  if (quotes.length === 0) return model.rules.length > 0 ? `${model.verdict} The expert's words are on your screen.` : model.verdict;
  return `${model.verdict} In the expert's words: ${quotes.map((q) => `“${q}”`).join(" ")}`;
}

/** A stop-rule warning, as the coach says it: the text the tutor agent would speak, precomputed by the server. */
export function interventionSpeech(intervention: InterventionView): string {
  return intervention.text;
}

export const revealKey = (entryId: string) => `reveal:${entryId}`;
export const interventionKey = (questionId: string) => `intervention:${questionId}`;

/** Where a keyed message stands with the browser voice: being said now, said, or neither. */
export type SpeechStatus = "speaking" | "spoken" | undefined;

/**
 * The intervention card's speech line, kept truthful about who speaks: the server's status when the
 * tutor agent is connected (or already spoke it), otherwise what the browser voice did.
 */
export function interventionSpeechLine(
  serverLine: string,
  intervention: InterventionView,
  voice: { agentConnected: boolean; supported: boolean; enabled: boolean; status: SpeechStatus },
): string {
  if (voice.agentConnected || intervention.speech === "spoken") return serverLine;
  if (voice.status === "spoken") return "Spoken by your coach";
  if (voice.status === "speaking") return "Your coach is saying";
  if (!voice.supported) return "Not read aloud (this browser has no speech voice)";
  if (!voice.enabled) return "Voice is off — your coach would say";
  return "Your coach says";
}

export type VoiceLike = { lang: string; localService: boolean; default: boolean; name: string };

/** An English voice, preferring one on the device (remote voices stall or cut off long sentences in some browsers). */
export function pickVoice<V extends VoiceLike>(voices: readonly V[]): V | undefined {
  const english = voices.filter((v) => v.lang.toLowerCase().startsWith("en"));
  return english.find((v) => v.localService && v.default) ?? english.find((v) => v.localService) ?? english[0];
}

/** The two globals the speaker uses; tests pass fakes. */
export type SpeechWindow = { speechSynthesis: SpeechSynthesis; SpeechSynthesisUtterance: typeof SpeechSynthesisUtterance };

export type StorageLike = Pick<Storage, "getItem" | "setItem">;

export type SpeakerSnapshot = {
  /** The browser can speak (Web Speech API present). */
  supported: boolean;
  /** The trainee's on/off choice (persisted; default on). */
  enabled: boolean;
  /** Someone else has the floor (the tutor agent is connected): nothing is spoken until every hold is released. */
  held: boolean;
  /** Key of the message being said (or about to be), if any. */
  speaking: string | null;
  /** Keys said in this tab session. */
  spoken: ReadonlySet<string>;
};

export type TutorSpeaker = {
  getSnapshot(): SpeakerSnapshot;
  subscribe(listener: () => void): () => void;
  setEnabled(enabled: boolean): void;
  toggle(): void;
  /** Speak a keyed message unless it was already said (this tab session) or is being said; false if not started. */
  speakOnce(key: string, text: string): boolean;
  /** Speak now even if said before (an explicit replay); cancels whatever is being said. */
  say(key: string, text: string): boolean;
  cancel(): void;
  /** Silence the browser voice (cancelling what it is saying) until the returned release is called; holds stack. */
  hold(): () => void;
  status(key: string): SpeechStatus;
};

export const VOICE_ENABLED_KEY = "vashistha.tutor.voice";
export const VOICE_SPOKEN_KEY = "vashistha.tutor.voice.spoken";
const MAX_REMEMBERED = 200;

function safely<T>(fn: () => T, fallback: T): T {
  try {
    return fn();
  } catch {
    return fallback;
  }
}

/**
 * A speaker over `speechSynthesis`. A message counts as said once its utterance starts (not when it is
 * queued), so a speak cancelled before it starts — a case switch, React's dev double effects — is said
 * again next time. Without `win` (server, or no Web Speech API) every call is a no-op.
 */
export function createTutorSpeaker(deps: {
  win: SpeechWindow | undefined;
  /** Persists the on/off choice (default on). */
  local?: () => StorageLike | null | undefined;
  /** Remembers what was said in this tab so a reload does not repeat it. */
  session?: () => StorageLike | null | undefined;
}): TutorSpeaker {
  const { win } = deps;
  const supported = win !== undefined;
  const listeners = new Set<() => void>();
  const stored = safely(() => deps.local?.()?.getItem(VOICE_ENABLED_KEY), null);
  const remembered = safely(() => {
    const raw = deps.session?.()?.getItem(VOICE_SPOKEN_KEY);
    const parsed: unknown = raw ? JSON.parse(raw) : [];
    return Array.isArray(parsed) ? parsed.filter((k): k is string => typeof k === "string") : [];
  }, [] as string[]);
  const spoken = new Set<string>(remembered);
  let enabled = stored !== "off";
  let holds = 0;
  let speaking: string | null = null;
  let current: SpeechSynthesisUtterance | null = null;
  let snapshot: SpeakerSnapshot = { supported, enabled, held: false, speaking, spoken: new Set(spoken) };

  const emit = () => {
    snapshot = { supported, enabled, held: holds > 0, speaking, spoken: new Set(spoken) };
    for (const l of listeners) l();
  };

  const remember = (key: string) => {
    spoken.add(key);
    safely(() => deps.session?.()?.setItem(VOICE_SPOKEN_KEY, JSON.stringify([...spoken].slice(-MAX_REMEMBERED))), undefined);
  };

  const stop = () => {
    const busy = current !== null || (win !== undefined && safely(() => win.speechSynthesis.speaking || win.speechSynthesis.pending, true));
    current = null;
    speaking = null;
    if (win && busy) safely(() => win.speechSynthesis.cancel(), undefined);
  };

  const setEnabled = (next: boolean) => {
    if (next === enabled) return;
    enabled = next;
    safely(() => deps.local?.()?.setItem(VOICE_ENABLED_KEY, next ? "on" : "off"), undefined);
    if (!next) stop();
    emit();
  };

  const speakNow = (key: string, text: string): boolean => {
    if (!win || holds > 0 || text.trim() === "") return false;
    stop();
    const utterance = safely(() => new win.SpeechSynthesisUtterance(text), null);
    if (utterance === null) return false;
    const voice = safely(() => pickVoice(win.speechSynthesis.getVoices()), undefined);
    utterance.lang = voice?.lang ?? "en-US";
    if (voice) utterance.voice = voice;
    utterance.onstart = () => {
      if (current !== utterance) return;
      remember(key);
      emit();
    };
    const finish = () => {
      if (current !== utterance) return;
      current = null;
      speaking = null;
      emit();
    };
    utterance.onend = finish;
    utterance.onerror = finish;
    current = utterance;
    speaking = key;
    const started = safely(() => {
      win.speechSynthesis.speak(utterance);
      return true;
    }, false);
    if (!started) {
      current = null;
      speaking = null;
    }
    emit();
    return started;
  };

  return {
    getSnapshot: () => snapshot,
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    setEnabled,
    toggle: () => setEnabled(!enabled),
    speakOnce(key, text) {
      if (!supported || !enabled || spoken.has(key) || speaking === key) return false;
      return speakNow(key, text);
    },
    say: (key, text) => speakNow(key, text),
    cancel() {
      if (current === null && speaking === null) return;
      stop();
      emit();
    },
    hold() {
      holds += 1;
      stop();
      emit();
      let released = false;
      return () => {
        if (released) return;
        released = true;
        holds -= 1;
        emit();
      };
    },
    status: (key) => (speaking === key ? "speaking" : spoken.has(key) ? "spoken" : undefined),
  };
}

function browserSpeaker(): TutorSpeaker {
  const win =
    typeof window !== "undefined" && "speechSynthesis" in window && typeof window.SpeechSynthesisUtterance === "function"
      ? (window as SpeechWindow)
      : undefined;
  return createTutorSpeaker({ win, local: () => window.localStorage, session: () => window.sessionStorage });
}

let shared: TutorSpeaker | undefined;
/** One speaker per page, so what was said survives remounts (each case has its own review column). */
function sharedSpeaker(): TutorSpeaker {
  shared ??= browserSpeaker();
  return shared;
}

const SERVER_SNAPSHOT: SpeakerSnapshot = { supported: false, enabled: true, held: false, speaking: null, spoken: new Set() };
const subscribe = (listener: () => void) => sharedSpeaker().subscribe(listener);
const getSnapshot = () => sharedSpeaker().getSnapshot();
const getServerSnapshot = () => SERVER_SNAPSHOT;

/** Stable across renders, so effects can depend on them. */
const ACTIONS: Omit<TutorSpeaker, "getSnapshot" | "subscribe" | "status"> = {
  setEnabled: (enabled) => sharedSpeaker().setEnabled(enabled),
  toggle: () => sharedSpeaker().toggle(),
  speakOnce: (key, text) => sharedSpeaker().speakOnce(key, text),
  say: (key, text) => sharedSpeaker().say(key, text),
  cancel: () => sharedSpeaker().cancel(),
  hold: () => sharedSpeaker().hold(),
};

export type TutorVoice = SpeakerSnapshot & Omit<TutorSpeaker, "getSnapshot" | "subscribe">;

/** The trainee's spoken coach (browser voice): on by default, a no-op where the browser cannot speak. */
export function useTutorVoice(): TutorVoice {
  const snap = useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);
  return {
    ...snap,
    ...ACTIONS,
    status: (key) => (snap.speaking === key ? "speaking" : snap.spoken.has(key) ? "spoken" : undefined),
  };
}

/**
 * Keep the browser voice silent while `active` (e.g. the tutor agent is connected and speaks for itself),
 * so it never talks over the agent. Any component may hold it; it speaks again once all holds are released.
 */
export function useHoldTutorVoice(active: boolean): void {
  useEffect(() => (active ? sharedSpeaker().hold() : undefined), [active]);
}
