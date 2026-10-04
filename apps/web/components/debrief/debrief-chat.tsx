"use client";

/**
 * The debrief as one conversation: the engine asks, the expert answers in their own words. Nothing is saved
 * from a free answer until the expert says yes to the read-back; every turn is in the ledger. Beside it, the
 * confirmed rulebook and coverage, read-only.
 */
import { useCallback, useEffect, useRef, useState, type FormEvent, type KeyboardEvent } from "react";
import Link from "next/link";
import { AnimatePresence, motion } from "framer-motion";
import { Check, CornerDownLeft, Loader2, Sparkles, X } from "lucide-react";
import { describeError } from "@/lib/client/api";
import type { DebriefConversation, DebriefState, DebriefTurn } from "@/lib/contracts/debrief";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Textarea } from "@/components/ui/textarea";
import { TraceButton } from "@/components/lineage/lineage-trace";
import { ConceptsStatus } from "@/components/concepts/concepts-panel";
import { getConversation, postConversation } from "./api";
import { CoveragePanel } from "./coverage-panel";

/** Topics whose question is answered with yes / no as often as not: offer those as one-tap replies (Skip is always offered). */
const QUICK_TOPICS = new Set(["proposal", "readback", "teach_back", "concept", "stop_rules", "witness"]);

export function DebriefChat({ sessionId, readOnly }: { sessionId: string; readOnly?: string | undefined }) {
  const [conv, setConv] = useState<DebriefConversation | null>(null);
  const [draft, setDraft] = useState("");
  const [pending, setPending] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const started = useRef(false);
  const bottom = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (started.current) return;
    started.current = true;
    const load = readOnly === undefined ? postConversation(fetch, sessionId, { type: "start" }) : getConversation(fetch, sessionId);
    load.then(setConv, (e: unknown) => setError(describeError(e)));
  }, [sessionId, readOnly]);

  useEffect(() => {
    bottom.current?.scrollIntoView({ behavior: "smooth", block: "end" });
  }, [conv?.turns.length, pending]);

  const send = useCallback(
    async (text: string) => {
      const words = text.trim();
      if (words === "" || pending !== null) return;
      setPending(words);
      setDraft("");
      try {
        setConv(await postConversation(fetch, sessionId, { type: "reply", text: words }));
        setError(null);
      } catch (e) {
        setError(describeError(e));
        setDraft(words);
      } finally {
        setPending(null);
      }
    },
    [pending, sessionId],
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

  const canReply = readOnly === undefined && conv !== null && (conv.awaiting !== null || conv.done);
  return (
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
                  placeholder={conv?.done === true ? "Thought of another rule? Just say it." : "Type your answer…"}
                  value={draft}
                  onChange={(e) => setDraft(e.target.value)}
                  onKeyDown={onKeyDown}
                  disabled={!canReply || pending !== null}
                  rows={2}
                  maxLength={1000}
                  className="min-h-[2.5rem] resize-none"
                />
                <Button type="submit" disabled={!canReply || pending !== null || draft.trim() === ""} aria-label="Send">
                  {pending !== null ? <Loader2 className="animate-spin" /> : <CornerDownLeft />}
                </Button>
              </div>
            </form>
          )}
        </CardContent>
      </Card>
      <div className="space-y-4">
        {conv !== null && <CoveragePanel coverage={conv.state.coverage} revision={conv.state.rulebookRevision} />}
        {conv !== null && <RulebookList state={conv.state} />}
        <ConceptsStatus sessionId={sessionId} refreshKey={conv?.turns.length ?? 0} />
        {conv?.done === true && (
          <Button asChild className="w-full">
            <Link href={`/workmap/${encodeURIComponent(sessionId)}`}>Open the Work Map</Link>
          </Button>
        )}
      </div>
    </div>
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
        <p>{turn.text}</p>
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

/** The confirmed rulebook, read-only: what the conversation has produced so far. */
function RulebookList({ state }: { state: DebriefState }) {
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
                <motion.li
                  key={r.rule.id}
                  layout
                  initial={{ opacity: 0, backgroundColor: "rgba(250, 204, 21, 0.35)" }}
                  animate={{ opacity: 1, backgroundColor: "rgba(250, 204, 21, 0)" }}
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
                </motion.li>
              ))}
            </AnimatePresence>
          </ul>
        )}
      </CardContent>
    </Card>
  );
}
