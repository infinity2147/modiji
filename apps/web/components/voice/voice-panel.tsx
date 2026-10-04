"use client";

import { useEffect, useRef } from "react";
import { AlertCircle, Check, Highlighter, Hourglass, Loader2, Mic, MicOff, PhoneOff, Radio, Volume2 } from "lucide-react";
import type { InterviewLoop, VoiceStatus } from "@/lib/client/voice/use-interview";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader } from "@/components/ui/card";
import { Pill, type Tone } from "@/components/casedesk/pills";
import { OffRecordControl } from "./off-record";

const AGENT_LABEL = { interviewer: "Interviewer agent", tutor: "Tutor agent" } as const;

function statusPill(voice: VoiceStatus): { tone: Tone; text: string } {
  switch (voice.state) {
    case "idle":
      return { tone: "neutral", text: "Not connected" };
    case "requesting":
    case "connecting":
      return { tone: "info", text: "Connecting…" };
    case "connected":
      return { tone: "success", text: "Connected" };
    case "not_configured":
      return { tone: "warning", text: "Not configured" };
    case "error":
      return { tone: "danger", text: "Error" };
    case "ended":
      return { tone: "neutral", text: "Ended" };
  }
}

function micText(loop: InterviewLoop): string {
  if (loop.privacyState?.offRecord) return "Microphone muted (off the record)";
  if (loop.voice.state !== "connected") return "Microphone off (no conversation)";
  return loop.micMuted ? "Microphone muted" : "Microphone live — sent to the voice provider";
}

/**
 * The voice side panel: connect/disconnect, the disclosed sensing state, the live transcript (expert
 * and agent turns; control messages never appear) and the off-record switch. Marked `data-gate-ignore`:
 * transcript updates are not the expert's screen moving.
 */
export function VoicePanel({ loop }: { loop: InterviewLoop }) {
  const { voice } = loop;
  const pill = statusPill(voice);
  const offRecord = loop.privacyState?.offRecord ?? true;
  const busy = voice.state === "requesting" || voice.state === "connecting";
  const logRef = useRef<HTMLOListElement>(null);
  const turns = loop.transcript.length;

  useEffect(() => {
    const log = logRef.current;
    if (log && turns > 0) log.scrollTop = log.scrollHeight;
  }, [turns]);

  return (
    <Card data-gate-ignore="" className="gap-0 py-0 shadow-xs" role="region" aria-labelledby="voice-title">
      <CardHeader className="flex flex-row items-center justify-between gap-2 border-b py-2.5!">
        <h2 id="voice-title" className="flex items-center gap-2 text-sm font-semibold">
          <Radio aria-hidden className="size-3.5 text-muted-foreground" />
          Voice · {AGENT_LABEL[loop.agent]}
        </h2>
        <span role="status" aria-label="Voice status">
          <Pill tone={pill.tone}>{pill.text}</Pill>
        </span>
      </CardHeader>
      <CardContent className="grid gap-3 py-3">
        <OffRecordControl state={loop.privacyState} />

        {loop.gate !== null && (
          <section aria-label="Why it is quiet" className="grid gap-2 rounded-2xl bg-muted/70 p-3">
            <h3 className="text-xs font-bold">
              {loop.gate.hud.status === "ASKING" ? "Your assistant is asking now" : loop.gate.hud.status === "WAITING" ? "Waiting for a good moment" : "Listening, and staying quiet"}
            </h3>
            <ul className="grid gap-1 text-xs">
              {loop.gate.hud.judge.map((row) => (
                <li key={row.key} className="flex items-center gap-2">
                  {row.ok ? <Check aria-hidden className="size-3.5 text-primary" /> : <Hourglass aria-hidden className="size-3.5 text-highlight" />}
                  <span className={row.ok ? "text-muted-foreground" : "font-semibold"}>{row.ok ? row.label : `${row.label}: ${row.text}`}</span>
                </li>
              ))}
            </ul>
            <p className="text-[11px] leading-snug text-muted-foreground">It only speaks when you pause, and only when the answer would teach it something.</p>
          </section>
        )}

        {voice.state === "not_configured" ? (
          <Alert>
            <AlertCircle />
            <AlertTitle>Voice not configured on this server</AlertTitle>
            <AlertDescription>
              Missing: <span className="font-mono text-[11px]">{voice.missing.join(", ") || "voice credentials"}</span>. CaseDesk,
              the gate HUD and the ledger keep working without voice.
            </AlertDescription>
          </Alert>
        ) : voice.state === "connected" ? (
          <Button variant="outline" size="sm" onClick={loop.disconnect}>
            <PhoneOff data-icon="inline-start" />
            End conversation
          </Button>
        ) : (
          <>
            <Button
              size="sm"
              onClick={loop.connect}
              disabled={busy || loop.startBlocked !== undefined}
              aria-describedby={loop.startBlocked === undefined ? undefined : "voice-blocked"}
            >
              {busy ? <Loader2 data-icon="inline-start" className="animate-spin" /> : <Mic data-icon="inline-start" />}
              {busy ? "Connecting…" : loop.agent === "interviewer" ? "Start interview" : "Connect voice"}
            </Button>
            {loop.startBlocked !== undefined && (
              <p id="voice-blocked" className="text-[11px] text-muted-foreground">
                {loop.startBlocked}
              </p>
            )}
          </>
        )}
        {voice.state === "error" && (
          <p role="alert" className="text-xs text-destructive">
            Voice error: {voice.message}
          </p>
        )}
        {voice.state === "ended" && <p className="text-xs text-muted-foreground">{voice.reason}.</p>}

        <ul aria-label="Sensing" className="grid gap-1 text-[11px] text-muted-foreground">
          <li className="flex items-center gap-1.5">
            {loop.micMuted || offRecord || voice.state !== "connected" ? (
              <MicOff aria-hidden className="size-3" />
            ) : (
              <Mic aria-hidden className="size-3 text-emerald-600" />
            )}
            {micText(loop)}
          </li>
          <li className="flex items-center gap-1.5">
            <Volume2 aria-hidden className={loop.agentSpeaking ? "size-3 text-sky-600" : "size-3"} />
            {loop.agentSpeaking ? "Agent speaking" : "Agent silent"}
          </li>
        </ul>

        {loop.cue !== null && (
          <p role="status" data-testid="question-cue" className="flex items-center gap-1.5 text-[11px] text-muted-foreground">
            <Highlighter aria-hidden className={loop.cue.shown ? "size-3 text-amber-600" : "size-3"} />
            {loop.cue.message}
          </p>
        )}

        <section aria-labelledby="transcript-title" className="grid gap-1.5">
          <h3 id="transcript-title" className="text-xs font-medium">
            Transcript
          </h3>
          {loop.transcript.length === 0 ? (
            <p className="text-[11px] text-muted-foreground">No turns yet.</p>
          ) : (
            <ol ref={logRef} role="log" aria-live="polite" className="grid max-h-48 gap-1.5 overflow-y-auto pr-1 text-[12px]">
              {loop.transcript.map((turn) => (
                <li key={turn.id} className={turn.role === "agent" ? "rounded-xl bg-highlight-soft px-2.5 py-1.5" : "rounded-xl bg-muted px-2.5 py-1.5"}>
                  <span className="font-medium">{turn.role === "agent" ? "Agent" : loop.agent === "interviewer" ? "Expert" : "You"}: </span>
                  {turn.text}
                </li>
              ))}
            </ol>
          )}
          {(loop.uploads.pending > 0 || loop.uploads.failed > 0) && (
            <p role="status" className="text-[11px] text-muted-foreground">
              {loop.uploads.pending > 0 && `Recording ${loop.uploads.pending} turn(s)… `}
              {loop.uploads.failed > 0 && (
                <span className="text-destructive">
                  {loop.uploads.failed} turn(s) not recorded: {loop.uploads.lastError}
                </span>
              )}
            </p>
          )}
        </section>
      </CardContent>
    </Card>
  );
}
