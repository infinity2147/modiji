"use client";

/**
 * The debrief as one conversation: the engine asks, the expert answers in their own words, typed or spoken
 * (Talk). Nothing is saved from a free answer until the expert says yes to the read-back; every turn is in the
 * ledger. Beside it, the confirmed rulebook and coverage, read-only.
 */
import { useCallback, useEffect, useRef, useState, type FormEvent, type KeyboardEvent } from "react";
import Link from "next/link";
import { ConversationProvider } from "@elevenlabs/react";
import { AnimatePresence, motion } from "framer-motion";
import { Check, CornerDownLeft, Loader2, Mic, Sparkles, Trash2, X } from "lucide-react";
import { ApiError, describeError } from "@/lib/client/api";
import { PrivacyContext } from "@/lib/client/voice/use-interview";
import type { DebriefConversation, DebriefState, DebriefTurn } from "@/lib/contracts/debrief";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Textarea } from "@/components/ui/textarea";
import { TraceButton } from "@/components/lineage/lineage-trace";
import { ConceptsStatus } from "@/components/concepts/concepts-panel";
import { OffRecordBanner } from "@/components/voice/off-record";
import { expertAction, getConversation, postConversation } from "./api";
import { CoveragePanel } from "./coverage-panel";
import { TalkButton, useDebriefVoice, VOICE_REFRESH_MS, voiceOn, VoiceStrip } from "./debrief-voice";

/** Topics whose question is answered with yes / no as often as not: offer those as one-tap replies (Skip is always offered). */
const QUICK_TOPICS = new Set(["proposal", "readback", "teach_back", "concept", "stop_rules", "witness"]);

/** The voice conversation lives in `ConversationProvider`; typing works without it. */
export function DebriefChat(props: { sessionId: string; readOnly?: string | undefined }) {
  return (
    <ConversationProvider>
      <DebriefChatBody {...props} />
    </ConversationProvider>
  );
}

function DebriefChatBody({ sessionId, readOnly }: { sessionId: string; readOnly?: string | undefined }) {
  const [conv, setConv] = useState<DebriefConversation | null>(null);
  const [draft, setDraft] = useState("");
  const [pending, setPending] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const started = useRef(false);
  const bottom = useRef<HTMLDivElement>(null);
  /** Bumped by every write: a re-read that started before it is stale and dropped. */
  const writes = useRef(0);
  const sending = useRef(false);
  const writable = readOnly === undefined;
  const voice = useDebriefVoice(sessionId, writable ? conv?.session : undefined);
  const offRecord = voice.privacyState?.offRecord === true;
  const { sensors } = voice;

  /** Deletes a rule with the expert's reason (`retire_rule`), then re-reads the conversation; rejects when refused. */
  const deleteRule = useCallback(
    async (ruleId: string, reason: string) => {
      writes.current += 1;
      await expertAction(fetch, sessionId, { action: "retire_rule", ruleId, quote: reason });
      writes.current += 1;
      setConv(await getConversation(fetch, sessionId));
    },
    [sessionId],
  );

  useEffect(() => {
    if (started.current) return;
    started.current = true;
    const load = writable
      ? postConversation(fetch, sessionId, { type: "start" }).catch((e: unknown) =>
          // Off the record the conversation cannot move on, but it can be read (and the record resumed here).
          e instanceof ApiError && e.code === "off_record" ? getConversation(fetch, sessionId) : Promise.reject(e),
        )
      : getConversation(fetch, sessionId);
    load.then(setConv, (e: unknown) => setError(describeError(e)));
  }, [sessionId, writable]);

  // Back on the record: start (or resume) the conversation, which could not move on while off it.
  const wasOffRecord = useRef(false);
  useEffect(() => {
    const resumed = wasOffRecord.current && !offRecord;
    wasOffRecord.current = offRecord;
    if (!resumed || !writable) return;
    writes.current += 1;
    postConversation(fetch, sessionId, { type: "start" }).then(
      (c) => {
        setConv(c);
        setError(null);
      },
      (e: unknown) => setError(describeError(e)),
    );
  }, [offRecord, writable, sessionId]);

  // While voice is on, spoken replies are applied by the server: re-read the conversation, and once more when it stops.
  const live = voiceOn(voice);
  useEffect(() => {
    if (!live) return;
    let stopped = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const reread = (): Promise<void> => {
      const seen = writes.current;
      return getConversation(fetch, sessionId).then(
        (c) => {
          if (seen === writes.current && !sending.current) setConv(c);
        },
        () => {}, // a missed re-read is retried on the next tick
      );
    };
    const tick = (): void => {
      void reread().finally(() => {
        if (!stopped) timer = setTimeout(tick, VOICE_REFRESH_MS);
      });
    };
    timer = setTimeout(tick, VOICE_REFRESH_MS);
    return () => {
      stopped = true;
      clearTimeout(timer);
      void reread();
    };
  }, [live, sessionId]);

  useEffect(() => {
    bottom.current?.scrollIntoView({ behavior: "smooth", block: "end" });
  }, [conv?.turns.length, pending]);

  const send = useCallback(
    async (text: string) => {
      const words = text.trim();
      if (words === "" || pending !== null) return;
      setPending(words);
      setDraft("");
      sending.current = true;
      writes.current += 1;
      try {
        setConv(await postConversation(fetch, sessionId, { type: "reply", text: words }));
        setError(null);
        // The reply queued the next turn: let the gate read it now rather than at its next poll.
        sensors.committed();
      } catch (e) {
        setError(describeError(e));
        setDraft(words);
      } finally {
        sending.current = false;
        setPending(null);
      }
    },
    [pending, sessionId, sensors],
  );

  const onSubmit = (e: FormEvent) => {
    e.preventDefault();
    void send(draft);
  };
  const onKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      void send(draft);
    }
  };

  const canReply = writable && conv !== null && !offRecord && (conv.awaiting !== null || conv.done);
  return (
    <PrivacyContext value={voice.privacy}>
      <div className="space-y-4">
        <div className="overflow-hidden rounded-lg empty:hidden">
          <OffRecordBanner state={voice.privacyState} />
        </div>
        <div className="grid gap-4 lg:grid-cols-[minmax(0,1.6fr)_minmax(0,1fr)]">
          <Card aria-label="Debrief conversation" className="flex min-h-[60vh] flex-col">
            <CardHeader className="pb-2">
              <CardTitle className="flex items-center gap-2 text-base">
                Talk it through
                {conv?.done === true && (
                  <Badge variant="secondary" data-testid="debrief-done">
                    <Check className="size-3" /> debrief finished
                  </Badge>
                )}
              </CardTitle>
              <p className="text-xs text-muted-foreground">
                Answer however you like. When I read a free answer, I say back what I understood and save it only after you say yes. Every rule keeps your exact words.
              </p>
            </CardHeader>
            <CardContent className="flex flex-1 flex-col gap-3">
              <ol className="flex-1 space-y-3 overflow-y-auto pr-1" data-testid="debrief-transcript" aria-live="polite">
                {conv === null && error === null && <li className="text-sm text-muted-foreground">Getting the first question ready…</li>}
                <AnimatePresence initial={false}>
                  {conv?.turns.map((t) => (
                    <TurnBubble key={t.id} turn={t} />
                  ))}
                  {pending !== null && <PendingBubble key="pending" text={pending} />}
                </AnimatePresence>
                <div ref={bottom} />
              </ol>
              {error !== null && (
                <p role="alert" className="rounded-md bg-destructive/10 px-3 py-2 text-sm text-destructive">
                  {error}
                </p>
              )}
              {readOnly !== undefined ? (
                <p role="status" className="rounded-md border bg-muted px-3 py-2 text-sm">
                  <strong>Read-only:</strong> {readOnly}. Only the expert who captured this session talks through its debrief.
                </p>
              ) : (
                <form onSubmit={onSubmit} className="space-y-2">
                  {conv !== null && !conv.llmAvailable && (
                    <p className="text-xs text-muted-foreground">The language model is off, so I understand yes, no and skip only.</p>
                  )}
                  {conv?.awaiting !== null && conv?.awaiting !== undefined && (
                    <div role="group" className="flex gap-2" aria-label="Quick replies">
                      {(QUICK_TOPICS.has(conv.awaiting.topic) ? ["Yes", "No", "Skip"] : ["Skip"]).map((q) => (
                        <Button key={q} type="button" variant="outline" size="sm" disabled={pending !== null} onClick={() => void send(q)}>
                          {q}
                        </Button>
                      ))}
                    </div>
                  )}
                  <div className="flex items-end gap-2">
                    <Textarea
                      aria-label="Your answer"
                      placeholder={offRecord ? "Off the record: resume the record to reply." : conv?.done === true ? "Thought of another rule? Just say it." : "Type your answer…"}
                      value={draft}
                      onChange={(e) => {
                        setDraft(e.target.value);
                        // The agent holds while the expert types (the gate's typing condition).
                        sensors.typing();
                      }}
                      onKeyDown={onKeyDown}
                      disabled={!canReply || pending !== null}
                      rows={2}
                      maxLength={1000}
                      className="min-h-[2.5rem] resize-none"
                    />
                    {conv !== null && <TalkButton loop={voice} />}
                    <Button type="submit" disabled={!canReply || pending !== null || draft.trim() === ""} aria-label="Send">
                      {pending !== null ? <Loader2 className="animate-spin" /> : <CornerDownLeft />}
                    </Button>
                  </div>
                  {conv !== null && <VoiceStrip loop={voice} />}
                </form>
              )}
            </CardContent>
          </Card>
          <div className="space-y-4">
            {conv !== null && <CoveragePanel coverage={conv.state.coverage} revision={conv.state.rulebookRevision} />}
            {conv !== null && <RulebookList state={conv.state} onDelete={writable && !offRecord ? deleteRule : undefined} />}
            <ConceptsStatus sessionId={sessionId} refreshKey={conv?.turns.length ?? 0} />
            {conv?.done === true && (
              <Button asChild className="w-full">
                <Link href={`/workmap/${encodeURIComponent(sessionId)}`}>Open the Work Map</Link>
              </Button>
            )}
          </div>
        </div>
      </div>
    </PrivacyContext>
  );
}

function TurnBubble({ turn }: { turn: DebriefTurn }) {
  const agent = turn.role === "agent";
  return (
    <motion.li
      layout
      initial={{ opacity: 0, y: 6 }}
      animate={{ opacity: 1, y: 0 }}
      className={`flex ${agent ? "justify-start" : "justify-end"}`}
      data-testid={agent ? "turn-agent" : "turn-expert"}
    >
      <div className={`max-w-[85%] space-y-1 rounded-2xl px-3 py-2 text-sm leading-relaxed ${agent ? "rounded-tl-sm bg-muted" : "rounded-tr-sm bg-primary text-primary-foreground"}`}>
        <p className="flex items-start gap-1.5" data-via={turn.via ?? undefined}>
          {turn.via === "voice" && <Mic role="img" aria-label="spoken" className="mt-1 size-3 shrink-0 opacity-80" />}
          <span>{turn.text}</span>
        </p>
        {!agent && turn.outcome !== null && <Outcome outcome={turn.outcome} />}
      </div>
    </motion.li>
  );
}

function Outcome({ outcome }: { outcome: NonNullable<DebriefTurn["outcome"]> }) {
  if (outcome.refused !== null)
    return (
      <p className="flex items-center gap-1 text-xs opacity-90" data-testid="turn-outcome">
        <X className="size-3" /> not saved: {outcome.refused}
      </p>
    );
  if (outcome.saved)
    return (
      <p className="flex items-center gap-1 text-xs opacity-90" data-testid="turn-outcome">
        <Check className="size-3" /> saved with your words
      </p>
    );
  if (outcome.byModel && outcome.readAs === "statement")
    return (
      <p className="flex items-center gap-1 text-xs opacity-90" data-testid="turn-outcome">
        <Sparkles className="size-3" /> read by the model: check the read-back
      </p>
    );
  return null;
}

function PendingBubble({ text }: { text: string }) {
  return (
    <motion.li initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} className="space-y-2">
      <div className="flex justify-end">
        <p className="max-w-[85%] rounded-2xl rounded-tr-sm bg-primary/70 px-3 py-2 text-sm text-primary-foreground">{text}</p>
      </div>
      <p className="flex items-center gap-2 text-xs text-muted-foreground">
        <Loader2 className="size-3 animate-spin" /> thinking…
      </p>
    </motion.li>
  );
}

/**
 * The confirmed rulebook: what the conversation has produced so far. With `onDelete` (the session's own expert),
 * each rule can be deleted: the expert says why in their own words (kept in the audit trail, `retire_rule`) and
 * confirms. Saying "drop that rule" in the conversation does the same.
 */
function RulebookList({ state, onDelete }: { state: DebriefState; onDelete?: ((ruleId: string, reason: string) => Promise<void>) | undefined }) {
  return (
    <Card aria-label="Confirmed rulebook">
      <CardHeader className="pb-2">
        <CardTitle className="flex items-center gap-2 text-base">
          Your rules
          <span className="font-mono text-xs text-muted-foreground" data-testid="rulebook-revision">
            revision {state.rulebookRevision}
          </span>
        </CardTitle>
      </CardHeader>
      <CardContent>
        {state.rules.length === 0 ? (
          <p className="text-sm text-muted-foreground">None yet. They appear here as you confirm them.</p>
        ) : (
          <ul className="space-y-2">
            <AnimatePresence initial={false}>
              {state.rules.map((r) => (
                <RuleItem key={r.rule.id} view={r} onDelete={onDelete} />
              ))}
            </AnimatePresence>
          </ul>
        )}
      </CardContent>
    </Card>
  );
}

function RuleItem({ view: r, onDelete }: { view: DebriefState["rules"][number]; onDelete?: ((ruleId: string, reason: string) => Promise<void>) | undefined }) {
  const [deleting, setDeleting] = useState(false);
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const confirm = async () => {
    setBusy(true);
    try {
      await onDelete?.(r.rule.id, reason.trim());
    } catch (e) {
      setError(describeError(e));
      setBusy(false);
    }
  };
  return (
    <motion.li
      layout
      initial={{ opacity: 0, backgroundColor: "rgba(250, 204, 21, 0.35)" }}
      animate={{ opacity: 1, backgroundColor: "rgba(250, 204, 21, 0)" }}
      exit={{ opacity: 0, height: 0 }}
      transition={{ duration: 1.2 }}
      className="rounded-md border p-2 text-sm"
      data-testid="rule"
    >
      <div className="flex items-start gap-2">
        <Badge variant={r.rule.kind === "guardrail" ? "destructive" : "secondary"} className="shrink-0">
          {r.rule.kind === "guardrail" ? "hard stop" : "rule"}
        </Badge>
        <p className="flex-1">
          When {r.when}, {r.then}.
        </p>
        <TraceButton entryId={r.entryId} label="rule" />
      </div>
      {r.rule.evidence[0] !== undefined && "exactQuote" in r.rule.evidence[0] && (
        <p className="mt-1 text-xs text-muted-foreground">
          you said <span className="italic">“{r.rule.evidence[0].exactQuote}”</span>
        </p>
      )}
      {onDelete !== undefined && !deleting && (
        <Button type="button" variant="ghost" size="xs" className="mt-1 text-destructive" onClick={() => setDeleting(true)}>
          <Trash2 /> Delete
        </Button>
      )}
      {onDelete !== undefined && deleting && (
        <div className="mt-2 space-y-2 rounded-md border border-destructive/40 bg-destructive/5 p-2" role="group" aria-label={`Delete rule ${r.rule.id}`}>
          <p className="text-xs">Delete this rule? Say why in your own words; your reason is kept in the audit trail.</p>
          <Textarea
            aria-label="Why delete it"
            placeholder="e.g. We don't do that any more."
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            rows={2}
            maxLength={1000}
            className="min-h-[2.5rem] resize-none bg-background"
          />
          {error !== null && (
            <p role="alert" className="text-xs text-destructive">
              {error}
            </p>
          )}
          <div className="flex gap-2">
            <Button type="button" variant="destructive" size="xs" disabled={busy || reason.trim().length < 3} onClick={() => void confirm()}>
              {busy ? <Loader2 className="animate-spin" /> : <Trash2 />} Delete rule
            </Button>
            <Button
              type="button"
              variant="ghost"
              size="xs"
              disabled={busy}
              onClick={() => {
                setDeleting(false);
                setError(null);
              }}
            >
              Cancel
            </Button>
          </div>
        </div>
      )}
    </motion.li>
  );
}
