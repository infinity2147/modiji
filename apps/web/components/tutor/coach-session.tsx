"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { AnimatePresence, motion, useReducedMotion } from "framer-motion";
import type { KycCase } from "@vashistha/core/domains/kyc";
import { AlertCircle, Check, Loader2, Mic, MicOff, MonitorUp, ShieldCheck, Sparkles, Square } from "lucide-react";
import { useScreenCapture } from "@/components/capture/use-screen-capture";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "@/components/ui/dialog";
import type { InterviewLoop } from "@/lib/client/voice/use-interview";
import type { Tutor } from "@/lib/client/tutor/use-tutor";
import { cn } from "@/lib/utils";

type Stage = "welcome" | "connecting" | "live" | "skipped";
type RowState = "waiting" | "working" | "ready" | "unavailable" | "problem";

const storageKey = (sessionId: string): string => `vashistha:coach:${sessionId}`;

function remembered(sessionId: string): "skipped" | undefined {
  try {
    return window.sessionStorage.getItem(storageKey(sessionId)) === "skipped" ? "skipped" : undefined;
  } catch {
    return undefined;
  }
}

function remember(sessionId: string, value: "skipped" | "cleared"): void {
  try {
    if (value === "cleared") window.sessionStorage.removeItem(storageKey(sessionId));
    else window.sessionStorage.setItem(storageKey(sessionId), value);
  } catch {
    // Private mode: the choice just is not remembered across a reload.
  }
}

/** The coach's presence: a soft orb that breathes while it connects and ripples while it is live. */
function Orb({ live, reduced }: { live: boolean; reduced: boolean }) {
  return (
    <div className="relative mx-auto grid size-24 place-items-center" aria-hidden>
      {!reduced &&
        [0, 1].map((i) => (
          <motion.span
            key={i}
            className="absolute inset-0 rounded-full bg-highlight/30"
            initial={{ scale: 0.7, opacity: 0.7 }}
            animate={{ scale: live ? 1.5 : 1.25, opacity: 0 }}
            transition={{ duration: live ? 1.6 : 2.4, repeat: Infinity, delay: i * 0.8, ease: "easeOut" }}
          />
        ))}
      <motion.span
        className="grid size-16 place-items-center rounded-full bg-primary text-primary-foreground shadow-lg"
        {...(reduced ? {} : { animate: { scale: [1, 1.06, 1] }, transition: { duration: 2.4, repeat: Infinity, ease: "easeInOut" as const } })}
      >
        <Sparkles className="size-7" />
      </motion.span>
    </div>
  );
}

function Row({
  icon: Icon,
  title,
  state,
  working,
  waiting,
  ready,
  problem,
}: {
  icon: typeof Mic;
  title: string;
  state: RowState;
  working: string;
  waiting: string;
  ready: string;
  problem: string;
}) {
  const text = { waiting, working, ready, unavailable: problem, problem }[state];
  return (
    <motion.li layout className="flex items-center gap-3 rounded-2xl border bg-card px-4 py-3" data-state={state}>
      <span
        className={cn(
          "grid size-10 shrink-0 place-items-center rounded-full transition-colors",
          state === "ready" ? "bg-primary text-primary-foreground" : state === "problem" || state === "unavailable" ? "bg-highlight-soft text-highlight-foreground" : "bg-muted text-muted-foreground",
        )}
      >
        {state === "ready" ? <Check className="size-5" /> : state === "working" ? <Loader2 className="size-5 animate-spin" /> : state === "problem" || state === "unavailable" ? <AlertCircle className="size-5" /> : <Icon className="size-5" />}
      </span>
      <span className="grid min-w-0 text-sm">
        <strong>{title}</strong>
        <span className="text-muted-foreground">{text}</span>
      </span>
    </motion.li>
  );
}

/**
 * The trainee's one step to a live coach. Taking a case opens a single friendly pop-up that asks for the
 * microphone and the screen together; saying yes turns both on, connects the voice coach and has it welcome
 * the trainee out loud from what the experts have taught. Nothing here is a tool to find: the voice panel is
 * only the fallback. The browser's own permission prompts still appear (that is not ours to skip), and a
 * "no" to either never blocks the practice: the coach keeps guiding in text.
 */
export function CoachSession({
  sessionId,
  caseId,
  cases,
  loop,
  tutor,
  ready,
  onSharingChange,
}: {
  sessionId: string;
  caseId: string | undefined;
  cases: readonly KycCase[];
  loop: InterviewLoop;
  tutor: Tutor;
  /** The coach has something to teach and a case is open. */
  ready: boolean;
  onSharingChange: (sharing: boolean) => void;
}) {
  const reduced = useReducedMotion() ?? false;
  const capture = useScreenCapture(sessionId, cases);
  const [stage, setStage] = useState<Stage>("welcome");
  const [asked, setAsked] = useState(false);
  const briefed = useRef(false);

  // A trainee who already said "not now" in this tab is not asked again on reload; the live bar still offers it.
  useEffect(() => {
    if (remembered(sessionId) === "skipped") setStage("skipped");
  }, [sessionId]);

  const sharing = capture.status?.state === "capturing";
  useEffect(() => onSharingChange(sharing), [sharing, onSharingChange]);

  const mic: RowState =
    loop.voice.state === "connected"
      ? "ready"
      : loop.voice.state === "requesting" || loop.voice.state === "connecting"
        ? "working"
        : loop.voice.state === "not_configured"
          ? "unavailable"
          : loop.voice.state === "error" || loop.voice.state === "ended"
            ? "problem"
            : "waiting";
  const screen: RowState = sharing ? "ready" : capture.error !== undefined ? "problem" : stage === "connecting" ? "working" : "waiting";

  // Voice is up: the coach welcomes the trainee out loud, once.
  const briefing = tutor.briefing;
  useEffect(() => {
    if (loop.voice.state !== "connected" || briefed.current) return;
    briefed.current = true;
    void briefing(caseId).catch(() => undefined);
  }, [loop.voice.state, caseId, briefing]);

  // Once the voice is up (and the screen has been answered either way) the pop-up gets out of the way.
  useEffect(() => {
    if (stage !== "connecting" || mic !== "ready" || (screen !== "ready" && screen !== "problem")) return;
    const timer = setTimeout(() => setStage("live"), reduced ? 0 : 1100);
    return () => clearTimeout(timer);
  }, [stage, mic, screen, reduced]);

  const begin = useCallback(() => {
    remember(sessionId, "cleared");
    setAsked(true);
    setStage("connecting");
    // getDisplayMedia must run synchronously inside this click; the microphone prompt follows on connect.
    capture.share();
    loop.connect();
  }, [capture, loop, sessionId]);

  const skip = useCallback(() => {
    remember(sessionId, "skipped");
    setStage("skipped");
  }, [sessionId]);

  const stop = useCallback(() => {
    loop.disconnect();
    capture.stop();
    briefed.current = false;
    remember(sessionId, "skipped");
    setStage("skipped");
  }, [capture, loop, sessionId]);

  const open = ready && (stage === "welcome" || stage === "connecting");
  const connecting = stage === "connecting";
  const stuck = connecting && (mic === "problem" || mic === "unavailable") && screen !== "waiting" && screen !== "working";

  return (
    <>
      <Dialog open={open} onOpenChange={(next) => !next && !connecting && skip()}>
        <DialogContent showCloseButton={false} className="gap-0 overflow-hidden rounded-3xl p-0 sm:max-w-md" data-testid="coach-dialog">
          <div className="grid gap-5 bg-gradient-to-b from-secondary to-card p-7 pb-6">
            <Orb live={connecting} reduced={reduced} />
            <AnimatePresence mode="wait" initial={false}>
              <motion.div
                key={stage}
                initial={reduced ? false : { opacity: 0, y: 10 }}
                animate={{ opacity: 1, y: 0 }}
                {...(reduced ? {} : { exit: { opacity: 0, y: -10 } })}
                transition={{ duration: 0.25 }}
                className="grid gap-4 text-center"
              >
                <DialogTitle className="font-heading text-2xl font-bold tracking-tight">
                  {connecting ? (stuck ? "Almost there" : "Starting your coach…") : "Meet your coach"}
                </DialogTitle>
                <DialogDescription className="text-sm leading-relaxed text-muted-foreground">
                  {connecting
                    ? "Say yes to your browser's prompts. Your coach starts as soon as the microphone is on."
                    : "Your coach teaches from what the experts decided. It talks with you out loud and follows your decisions as you work."}
                </DialogDescription>
              </motion.div>
            </AnimatePresence>
          </div>

          <div className="grid gap-4 p-6 pt-5">
            {connecting ? (
              <ul className="grid gap-2.5" aria-live="polite">
                <Row icon={Mic} title="Microphone" state={mic} waiting="Waiting to start" working="Allow the microphone in your browser" ready="On: your coach can hear you" problem={loop.voice.state === "not_configured" ? "Voice is not set up on this server, so your coach will guide you in text" : "Could not start: your coach will guide you in text"} />
                <Row icon={MonitorUp} title="Screen" state={screen} waiting="Waiting to start" working="Pick the screen or window to share" ready="Shared with this session" problem={capture.error ?? "Not shared: that is fine, your coach still follows your work"} />
              </ul>
            ) : (
              <ul className="grid gap-2.5 text-sm">
                {[
                  { icon: Mic, title: "Microphone", body: "So you can talk with your coach. It is only on while your coach is." },
                  { icon: MonitorUp, title: "Screen", body: "Shared with this session. Sensitive text is blurred in your browser before it leaves." },
                  { icon: ShieldCheck, title: "You are in control", body: "Say “off the record” or press Stop at any time." },
                ].map(({ icon: Icon, title, body }, i) => (
                  <motion.li
                    key={title}
                    initial={reduced ? false : { opacity: 0, x: -8 }}
                    animate={{ opacity: 1, x: 0 }}
                    transition={{ delay: reduced ? 0 : 0.1 + i * 0.08 }}
                    className="flex items-start gap-3"
                  >
                    <span className="mt-0.5 grid size-8 shrink-0 place-items-center rounded-full bg-secondary text-primary">
                      <Icon className="size-4" />
                    </span>
                    <span className="grid">
                      <strong>{title}</strong>
                      <span className="text-muted-foreground">{body}</span>
                    </span>
                  </motion.li>
                ))}
              </ul>
            )}

            {!connecting && (
              <div className="grid gap-2">
                <Button size="lg" variant="highlight" className="w-full" onClick={begin} data-testid="coach-allow">
                  Allow microphone and screen
                </Button>
                <Button variant="ghost" className="w-full text-muted-foreground" onClick={skip} data-testid="coach-skip">
                  Not now, coach me in text
                </Button>
              </div>
            )}
            {stuck && (
              <Button size="lg" className="w-full" onClick={() => setStage("live")} data-testid="coach-continue">
                Continue with text coaching
              </Button>
            )}
          </div>
        </DialogContent>
      </Dialog>

      {/* The live bar: where the coach is, and the one way to stop or start it. */}
      {ready && (stage === "live" || stage === "skipped") && (
        <motion.section
          initial={reduced ? false : { opacity: 0, y: -6 }}
          animate={{ opacity: 1, y: 0 }}
          aria-label="Coach status"
          data-testid="coach-bar"
          data-live={mic === "ready"}
          className={cn("flex flex-wrap items-center gap-3 rounded-2xl border px-4 py-3", mic === "ready" ? "bg-secondary" : "bg-card")}
        >
          <span className="flex items-center gap-2 text-sm font-semibold">
            <span className={cn("size-2.5 rounded-full", mic === "ready" ? "bg-primary" : "bg-muted-foreground/50")} aria-hidden />
            {mic === "ready" ? "Your coach is live" : asked && stage === "live" ? "Coaching in text" : "Voice coach is off"}
          </span>
          {mic === "ready" && (
            <span className="flex items-center gap-3 text-xs text-muted-foreground">
              <span className="flex items-center gap-1">{loop.micMuted ? <MicOff className="size-3.5" aria-hidden /> : <Mic className="size-3.5" aria-hidden />} microphone</span>
              <span className="flex items-center gap-1">
                <MonitorUp className="size-3.5" aria-hidden /> {sharing ? "screen shared" : "screen not shared"}
              </span>
            </span>
          )}
          <span className="ml-auto">
            {mic === "ready" ? (
              <Button size="sm" variant="outline" onClick={stop}>
                <Square data-icon="inline-start" /> Stop
              </Button>
            ) : (
              <Button
                size="sm"
                onClick={() => {
                  remember(sessionId, "cleared");
                  setStage("welcome");
                }}
              >
                Turn on voice coach
              </Button>
            )}
          </span>
        </motion.section>
      )}
    </>
  );
}
