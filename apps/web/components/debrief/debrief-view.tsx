"use client";

/**
 * The debrief (plan §7.5, demo step 3): gaps with their sources, solver witnesses and their debrief
 * questions, proposed (unconfirmed) rules, the confirmed rulebook with its animated diff, the
 * teach-back, and "Coverage under current model". Everything shown is computed by the server from
 * the ledger; the page only records the expert's explicit answers (with their own words).
 */
import { useState } from "react";
import Link from "next/link";
import { Check, X } from "lucide-react";
import type { DebriefState, ExpertActionRequest } from "@/lib/contracts/debrief";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { LineageProvider, TraceButton } from "@/components/lineage/lineage-trace";
import { QuoteForm } from "./quote-form";
import { actionLabel } from "./witness-card";
import { DebriefChat } from "./debrief-chat";

const GAP_SOURCE: Record<DebriefState["gaps"][number]["source"], string> = {
  live_question: "queued live question",
  unexplained_decision: "unexplained decision",
  undefined_concept: "undefined concept",
  witness: "solver witness",
};

/**
 * `readOnly`: why the viewer may not write to this session (another account's, e.g. an admin
 * reviewing it). The conversation is then shown without a reply box; the server refuses writes anyway.
 */
export function DebriefView({ sessionId, readOnly }: { sessionId: string; readOnly?: string | undefined }) {
  return (
    <LineageProvider sessionId={sessionId}>
      <main className="mx-auto max-w-7xl space-y-4 px-4 py-6">
        <header className="flex flex-wrap items-center gap-3">
          <div>
            <h1 className="text-2xl font-semibold tracking-tight">Debrief</h1>
            <p className="font-mono text-xs text-muted-foreground">expert session {sessionId}</p>
          </div>
          <div className="ml-auto flex items-center gap-2">
            <Button asChild variant="outline" size="sm">
              <Link href={`/sandbox?session=${encodeURIComponent(sessionId)}&set=training&mode=expert`}>CaseDesk</Link>
            </Button>
            <Button asChild variant="outline" size="sm">
              <Link href="/experts">Two experts</Link>
            </Button>
            <Button asChild size="sm">
              <Link href={`/workmap/${encodeURIComponent(sessionId)}`}>Work Map</Link>
            </Button>
          </div>
        </header>
        <DebriefChat sessionId={sessionId} readOnly={readOnly} />
      </main>
    </LineageProvider>
  );
}

export function TeachBackPanel({ state, busy, generate, act }: { state: DebriefState; busy: boolean; generate: () => void; act: (b: ExpertActionRequest) => Promise<void> }) {
  const tb = state.teachBack;
  const awaiting = tb !== null && tb.current && tb.confirmedEntryId === null;
  return (
    <Card aria-label="Teach-back" data-testid="teachback">
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          Teach-back
          {tb !== null && <Badge variant="outline">{tb.origin === "llm" ? "Opus prose · non-authoritative" : "template (LLM unavailable)"}</Badge>}
          {tb?.confirmedEntryId !== null && tb !== null && <Badge>confirmed</Badge>}
          {tb !== null && !tb.current && <Badge variant="destructive">stale: rulebook changed</Badge>}
          {tb !== null && <TraceButton entryId={tb.entryId} label="teach-back" className="ml-auto" />}
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-3">
        {tb === null ? (
          <p className="text-muted-foreground">Written from confirmed rules only, then spoken by the interviewer for the expert to confirm or correct.</p>
        ) : (
          <p className="rounded-md bg-muted px-3 py-2 leading-relaxed" data-testid="teachback-text">
            {tb.text}
          </p>
        )}
        <Button size="sm" variant={awaiting ? "outline" : "default"} disabled={busy || state.rules.length === 0} onClick={generate}>
          {tb === null ? "Write teach-back" : "Write a new teach-back"}
        </Button>
        {awaiting && (
          <>
            <QuoteForm submitLabel="Confirm teach-back" placeholder="Yes, that's right." onSubmit={(quote) => act({ action: "confirm_teachback", teachBackId: tb.entryId, quote })} />
            <p className="text-xs text-muted-foreground">To correct it, use “Correct this rule” in the rulebook: the rule is revised and a new teach-back is written.</p>
          </>
        )}
      </CardContent>
    </Card>
  );
}

export function DecisionsCard({ state }: { state: DebriefState }) {
  return (
    <Card aria-label="Observed decisions">
      <CardHeader>
        <CardTitle>Observed decisions</CardTitle>
      </CardHeader>
      <CardContent>
        <ul className="space-y-1">
          {state.decisions.map((d) => (
            <li key={d.entryId} className="flex items-center gap-2" data-explained={d.explained}>
              {d.explained ? <Check className="size-4 text-emerald-600" aria-label="explained" /> : <X className="size-4 text-destructive" aria-label="unexplained" />}
              <span className="font-mono text-xs">{d.caseId}</span>
              <span className="flex-1">{d.actionLabel}</span>
              <TraceButton entryId={d.entryId} label={`decision ${d.caseId}`} />
            </li>
          ))}
        </ul>
      </CardContent>
    </Card>
  );
}

export function GapsCard({ state }: { state: DebriefState }) {
  return (
    <Card aria-label="Gaps">
      <CardHeader>
        <CardTitle>Open gaps ({state.gaps.length})</CardTitle>
        <p className="text-xs text-muted-foreground">Queued live questions are listed for completeness; coverage depends on the four criteria above.</p>
      </CardHeader>
      <CardContent>
        {state.gaps.length === 0 ? (
          <p className="text-muted-foreground">None.</p>
        ) : (
          <ul className="space-y-1.5">
            {state.gaps.map((g) => (
              <li key={`${g.source}-${g.id}`} className="flex items-start gap-2 text-sm">
                <Badge variant="outline">{GAP_SOURCE[g.source]}</Badge>
                <span className="flex-1">{g.text}</span>
                <TraceButton entryId={g.ledgerEntryId} label={GAP_SOURCE[g.source]} />
              </li>
            ))}
          </ul>
        )}
      </CardContent>
    </Card>
  );
}

export function ProposalsCard({ state, act }: { state: DebriefState; act: (b: ExpertActionRequest) => Promise<void> }) {
  const [open, setOpen] = useState<string | null>(null);
  return (
    <Card aria-label="Proposed rules">
      <CardHeader>
        <CardTitle>Proposed rules (unconfirmed)</CardTitle>
        <p className="text-xs text-muted-foreground">Hypotheses and the expert&apos;s own statements. Nothing here enforces anything until the expert confirms it in their own words.</p>
      </CardHeader>
      <CardContent>
        <ul className="space-y-2">
          {state.proposals.map((p) => (
            <li key={p.candidateId} className="rounded-md border p-2" data-testid="proposal">
              <div className="flex flex-wrap items-center gap-2 text-sm">
                <Badge variant="outline">{p.origin === "expert_statement" ? "expert said" : p.origin}</Badge>
                <span className="flex-1">
                  When {p.text} → <strong>{actionLabel(p.action)}</strong>
                </span>
                <span className="font-mono text-xs text-muted-foreground">w {p.weight.toFixed(2)}</span>
                <Button size="xs" variant="outline" onClick={() => setOpen(open === p.candidateId ? null : p.candidateId)}>
                  Confirm…
                </Button>
              </div>
              {open === p.candidateId && (
                <div className="mt-2">
                  <QuoteForm
                    submitLabel="Confirm as rule"
                    placeholder="e.g. Yes — any PEP goes to enhanced review."
                    onSubmit={async (quote) => {
                      await act({ action: "confirm_candidate", candidateId: p.candidateId, decisionFamily: p.decisionFamily, quote });
                      setOpen(null);
                    }}
                  />
                </div>
              )}
            </li>
          ))}
        </ul>
      </CardContent>
    </Card>
  );
}
