"use client";

import { useState, type FormEvent } from "react";
import { AnimatePresence, motion, useReducedMotion } from "framer-motion";
import { ArrowUp, Loader2 } from "lucide-react";
import { describeError } from "@/lib/client/api";
import { useCoachTurnVoice, useTutorVoice } from "@/lib/client/tutor/speech";
import type { Tutor } from "@/lib/client/tutor/use-tutor";
import { COACH_ACTIVITY_TEXT, coachActivity, conversationLines } from "@/lib/client/tutor/view";
import type { InterviewLoop } from "@/lib/client/voice/use-interview";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

/**
 * The trainee's conversation with the coach, kept small and calm: the last few lines as captions ("Coach" /
 * "You"), one word on what the coach is doing (listening, thinking, speaking) and a box to type to it. Works with
 * or without voice: with the voice coach on, a reply is spoken by the coach; without it, the browser's own voice
 * reads new coach lines (`useCoachTurnVoice`). Marked `data-gate-ignore`: typing here and new captions are not the
 * trainee's casework, so they never count as typing or screen motion for the speech gate.
 */
export function CoachConversation({ tutor, loop, offRecord }: { tutor: Tutor; loop: InterviewLoop; offRecord: boolean }) {
  const reduced = useReducedMotion() ?? false;
  const [draft, setDraft] = useState("");
  const [asked, setAsked] = useState<{ text: string } | null>(null);
  const [reply, setReply] = useState<{ text: string } | null>(null);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string>();
  // Only what the trainee says on this page is captioned before the server has it; earlier speech is in `coach`.
  const [mountedAt] = useState(() => Date.now());

  const voiceLive = loop.voice.state === "connected";
  const turns = tutor.state?.coach;
  useCoachTurnVoice(turns, voiceLive);
  const voice = useTutorVoice();

  const spoken = loop.transcript.filter((t) => t.role === "user" && t.at >= mountedAt).slice(-2);
  const lines = conversationLines({ server: turns ?? [], spoken, asked, reply });
  const activity = coachActivity({
    voiceLive,
    agentSpeaking: voiceLive && loop.agentSpeaking,
    browserSpeaking: !voiceLive && voice.speaking !== null,
    awaitingReply: pending || (voiceLive && (loop.gate?.awaitingReply === true || loop.gate?.hud.status === "ASKING")),
  });

  const send = (event: FormEvent) => {
    event.preventDefault();
    const text = draft.trim();
    if (text === "" || pending || offRecord) return;
    setDraft("");
    setAsked({ text });
    setReply(null);
    setError(undefined);
    setPending(true);
    // With the voice coach on, the reply is spoken as soon as it is queued: read the queue fast until it is.
    if (voiceLive) loop.expectCoachReply();
    tutor.chat(text).then(
      (answer) => {
        setPending(false);
        if (answer.text.trim() !== "") setReply({ text: answer.text });
        if (voiceLive && answer.queued) loop.expectCoachReply();
      },
      (failure: unknown) => {
        setPending(false);
        setError(`Your coach could not answer just now (${describeError(failure)}). Try again.`);
      },
    );
  };

  return (
    <section aria-label="Talk with your coach" data-testid="coach-conversation" data-gate-ignore="" className="grid gap-3 rounded-2xl border bg-card p-4">
      <p
        className={cn("flex items-center gap-2 text-xs text-muted-foreground", activity === null && lines.length > 0 && "sr-only")}
        aria-live="polite"
        data-testid="coach-activity"
        data-activity={activity ?? "idle"}
      >
        <span
          aria-hidden
          className={cn(
            "size-2 rounded-full",
            activity === "speaking" ? "bg-primary" : activity === "thinking" ? "animate-pulse bg-highlight" : activity === "listening" ? "bg-primary/60" : "bg-muted-foreground/40",
          )}
        />
        {activity === null ? "Type below to ask your coach anything about this case." : COACH_ACTIVITY_TEXT[activity]}
      </p>

      {lines.length > 0 && (
        <ol className="grid gap-2" aria-label="Recent conversation" data-testid="coach-captions">
          <AnimatePresence initial={false}>
            {lines.map((line) => (
              <motion.li
                key={line.key}
                layout={!reduced}
                initial={reduced ? false : { opacity: 0, y: 6 }}
                animate={{ opacity: 1, y: 0 }}
                transition={{ duration: 0.2 }}
                data-role={line.role}
                className={cn("grid gap-0.5 rounded-xl px-3 py-2 text-sm leading-snug", line.role === "coach" ? "bg-secondary" : "bg-muted/60")}
              >
                <span className={cn("text-[11px] font-semibold", line.role === "coach" ? "text-primary" : "text-muted-foreground")}>
                  {line.role === "coach" ? "Coach" : "You"}
                </span>
                <span>{line.text}</span>
              </motion.li>
            ))}
          </AnimatePresence>
        </ol>
      )}

      <form onSubmit={send} className="flex items-center gap-2">
        <label htmlFor="coach-ask" className="sr-only">
          Ask your coach
        </label>
        <input
          id="coach-ask"
          value={draft}
          onChange={(event) => setDraft(event.target.value)}
          placeholder="Ask your coach…"
          maxLength={1000}
          autoComplete="off"
          disabled={offRecord}
          data-testid="coach-ask"
          className="h-9 min-w-0 flex-1 rounded-full border border-input bg-transparent px-3.5 text-sm outline-none placeholder:text-muted-foreground focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 disabled:cursor-not-allowed disabled:opacity-50"
        />
        <Button type="submit" size="icon-lg" aria-label="Send to your coach" disabled={offRecord || pending || draft.trim() === ""} data-testid="coach-send">
          {pending ? <Loader2 aria-hidden className="animate-spin" /> : <ArrowUp aria-hidden />}
        </Button>
      </form>
      {error && (
        <p role="alert" className="text-xs text-destructive">
          {error}
        </p>
      )}
    </section>
  );
}
