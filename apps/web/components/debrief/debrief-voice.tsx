"use client";

/**
 * Voice for the debrief conversation: the interviewer agent speaks the conversation's turns and the expert
 * answers aloud. The browser gate here speaks `debrief_turn` questions only, and only text the server
 * authorised; the expert's spoken replies are recorded as utterances and applied to the conversation by the
 * server, so the chat re-reads the conversation while voice is on. Typing keeps working throughout.
 *
 * No screen is needed: rules confirmed in the debrief cite the frames captured during the session.
 */
import { useState } from "react";
import { Loader2, Mic, Volume2 } from "lucide-react";
import type { QuestionKind } from "@vashistha/core";
import type { DebriefConversation } from "@/lib/contracts/debrief";
import { useInterviewLoop, type CaptureControl, type InterviewLoop } from "@/lib/client/voice/use-interview";
import { Button } from "@/components/ui/button";
import { Pill, type Tone } from "@/components/casedesk/pills";
import { OffRecordControl } from "@/components/voice/off-record";

/** The debrief page has no DOM or frame capture of its own: privacy changes have nothing else to stop. */
const NO_CAPTURE: CaptureControl = { suspend: () => {}, resume: () => {} };
const DEBRIEF_KINDS: ReadonlySet<QuestionKind> = new Set(["debrief_turn"]);

/** How often the conversation is re-read while voice is on (spoken replies are applied server-side). */
export const VOICE_REFRESH_MS = 1500;

type SessionInfo = DebriefConversation["session"];

/**
 * The interviewer's voice loop for the debrief. `session` is the conversation's session block, or undefined
 * while loading and for read-only viewers (nothing starts then). The privacy state and language are taken
 * from the first load only: later reads must not rebuild the privacy controller mid-transition.
 */
export function useDebriefVoice(sessionId: string, session: SessionInfo | undefined): InterviewLoop {
  const [initial, setInitial] = useState<SessionInfo | undefined>(session);
  if (initial === undefined && session !== undefined) setInitial(session);
  return useInterviewLoop({
    sessionId,
    mode: "expert",
    privacyInit: initial && { offRecord: initial.offRecord, epoch: initial.privacyEpoch },
    capture: NO_CAPTURE,
    screenShared: false,
    requireScreen: false,
    ...(initial !== undefined && { language: initial.expertLanguage }),
    questionKinds: DEBRIEF_KINDS,
  });
}

/** Voice is on (or turning on): the microphone may be live and the conversation should be re-read. */
export function voiceOn(loop: InterviewLoop): boolean {
  return loop.voice.state === "requesting" || loop.voice.state === "connecting" || loop.voice.state === "connected";
}

function status(loop: InterviewLoop): { tone: Tone; text: string } {
  const { voice } = loop;
  switch (voice.state) {
    case "idle":
    case "ended":
      return { tone: "neutral", text: "Voice off" };
    case "requesting":
    case "connecting":
      return { tone: "info", text: "Connecting…" };
    case "not_configured":
      return { tone: "warning", text: "Voice not set up" };
    case "error":
      return { tone: "danger", text: "Voice error" };
    case "connected":
      if (loop.privacyState?.offRecord) return { tone: "warning", text: "Muted · off the record" };
      if (loop.agentSpeaking) return { tone: "info", text: "Speaking…" };
      return loop.micMuted ? { tone: "warning", text: "Muted" } : { tone: "success", text: "Listening" };
  }
}

/** Talk on / off, beside Send. A toggle: its name stays "Talk", `aria-pressed` says whether it is on. */
export function TalkButton({ loop }: { loop: InterviewLoop }) {
  const on = voiceOn(loop);
  const requesting = loop.voice.state === "requesting";
  const blocked = !on && loop.startBlocked !== undefined;
  return (
    <Button
      type="button"
      variant={on ? "default" : "outline"}
      aria-pressed={on}
      aria-describedby="debrief-voice-status"
      title={blocked ? loop.startBlocked : on ? "Stop talking: the microphone turns off" : "Talk instead of typing: the microphone turns on"}
      disabled={requesting || blocked}
      onClick={on ? loop.disconnect : loop.connect}
      className={on ? "bg-emerald-700 text-white hover:bg-emerald-800" : undefined}
    >
      {requesting || loop.voice.state === "connecting" ? <Loader2 className="animate-spin" /> : <Mic />}
      Talk
    </Button>
  );
}

/** The live voice status, the microphone disclosure and the off-record switch, under the reply box. */
export function VoiceStrip({ loop }: { loop: InterviewLoop }) {
  const pill = status(loop);
  const { voice } = loop;
  return (
    <div data-gate-ignore="" className="grid gap-2 rounded-lg border bg-muted/40 p-2 sm:grid-cols-[minmax(0,1fr)_15rem] sm:items-center">
      <div className="flex min-w-0 flex-wrap items-center gap-2 text-xs">
        <span role="status" id="debrief-voice-status" aria-label="Voice status">
          <Pill tone={pill.tone}>
            {voice.state === "connected" && loop.agentSpeaking && <Volume2 aria-hidden className="size-3" />}
            {pill.text}
          </Pill>
        </span>
        <span className="text-muted-foreground">Microphone is on only while Talk is on.</span>
        {voice.state === "not_configured" && (
          <span className="basis-full text-muted-foreground">
            Voice isn&apos;t set up on this server (missing <span className="font-mono text-[11px]">{voice.missing.join(", ") || "voice credentials"}</span>). Typing works as usual.
          </span>
        )}
        {voice.state === "error" && (
          <span role="alert" className="basis-full text-destructive">
            Voice stopped: {voice.message}
          </span>
        )}
        {loop.uploads.failed > 0 && (
          <span role="alert" className="basis-full text-destructive">
            {loop.uploads.failed} spoken answer(s) not recorded: {loop.uploads.lastError}
          </span>
        )}
      </div>
      <OffRecordControl state={loop.privacyState} />
    </div>
  );
}
