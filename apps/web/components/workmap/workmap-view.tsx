"use client";

/**
 * The Work Map (plan §7.6, demo step 4): timeline with redacted thumbnails, step cards (screen moment,
 * decision, the expert's reason quote with ▶ clip, guardrails), the rule graph, coverage, lineage
 * traces and the exports. Built by code; only step titles and the summary may come from a model, and
 * they are labelled as such.
 */
import { useEffect, useState } from "react";
import Link from "next/link";
import { motion } from "framer-motion";
import { Download, Play, ShieldAlert } from "lucide-react";
import { KYC_DOMAIN } from "@vashistha/core/domains/kyc";
import type { WorkMapStep } from "@vashistha/core";
import { describeError } from "@/lib/client/api";
import type { WorkMapResponse } from "@/lib/contracts/debrief";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { exportUrl, getWorkMap } from "@/components/debrief/api";
import { CoveragePanel } from "@/components/debrief/coverage-panel";
import { LineageProvider, TraceButton, useTrace } from "@/components/lineage/lineage-trace";
import { RuleGraph } from "./rule-graph";

function actionLabel(id: string): string {
  return KYC_DOMAIN.actions.find((a) => a.id === id)?.label ?? id;
}

export function WorkMapView({ sessionId }: { sessionId: string }) {
  const [data, setData] = useState<WorkMapResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    getWorkMap(fetch, sessionId).then(setData, (e: unknown) => setError(describeError(e)));
  }, [sessionId]);

  return (
    <LineageProvider sessionId={sessionId}>
      <main className="mx-auto max-w-7xl space-y-4 px-4 py-6">
        <header className="flex flex-wrap items-center gap-3">
          <div>
            <h1 className="text-2xl font-semibold tracking-tight">Work Map</h1>
            <p className="font-mono text-xs text-muted-foreground">
              {data === null ? sessionId : `${data.workMap.id} · rulebook revision ${data.workMap.rulebookRevision} · built by code from the ledger`}
            </p>
          </div>
          <div className="ml-auto flex gap-2">
            <Button asChild variant="outline" size="sm">
              <Link href={`/debrief/${encodeURIComponent(sessionId)}`}>Debrief</Link>
            </Button>
          </div>
        </header>
        {error !== null && (
          <p role="alert" className="rounded-md bg-destructive/10 px-3 py-2 text-destructive">
            {error}
          </p>
        )}
        {data === null && error === null && <p className="text-muted-foreground">Building the Work Map…</p>}
        {data !== null && <Body data={data} sessionId={sessionId} />}
      </main>
    </LineageProvider>
  );
}

function Body({ data, sessionId }: { data: WorkMapResponse; sessionId: string }) {
  const { workMap } = data;
  const trace = useTrace();
  const proseLabel = data.proseOrigin === "llm" ? "titles & summary: Opus (non-authoritative)" : "titles & summary: template (LLM unavailable)";
  return (
    <>
      {workMap.summary !== "" && (
        <p className="text-muted-foreground">
          {workMap.summary} <Badge variant="outline">{proseLabel}</Badge>
        </p>
      )}
      <Timeline steps={workMap.steps} moments={data.moments} />
      <div className="grid gap-4 lg:grid-cols-[minmax(0,1.6fr)_minmax(0,1fr)]">
        <div className="space-y-3">
          {workMap.steps.map((s) => (
            <StepCard key={s.id} step={s} data={data} proseLabel={proseLabel} />
          ))}
          {workMap.steps.length === 0 && <p className="text-muted-foreground">No committed expert decisions yet.</p>}
        </div>
        <div className="space-y-4">
          <CoveragePanel coverage={workMap.coverage} revision={workMap.rulebookRevision} />
          <Card aria-label="Rule graph">
            <CardHeader>
              <CardTitle>Rule graph</CardTitle>
              <p className="text-xs text-muted-foreground">Families, priority order, guardrails (red), override edges (dashed). Click a rule to trace it.</p>
            </CardHeader>
            <CardContent>
              <RuleGraph rules={workMap.rules} text={data.ruleText} onTrace={(r) => trace?.trace(data.ruleText[r.id]?.entryId ?? data.generatedEntryId, `rule ${r.id}`)} />
            </CardContent>
          </Card>
          <Exports data={data} sessionId={sessionId} />
        </div>
      </div>
    </>
  );
}

function Timeline({ steps, moments }: { steps: readonly WorkMapStep[]; moments: WorkMapResponse["moments"] }) {
  return (
    <ol className="flex gap-3 overflow-x-auto pb-2" aria-label="Timeline">
      {steps.map((s, i) => {
        const frame = moments[s.id]?.find((m) => m.mediaUrl !== null);
        return (
          <motion.li key={s.id} initial={{ opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }} transition={{ delay: i * 0.12 }} className="w-56 shrink-0">
            <a href={`#${s.id}`} className="block rounded-lg border bg-card p-2 hover:border-primary">
              {frame?.mediaUrl ? (
                <img src={frame.mediaUrl} alt={`Redacted frame of ${s.caseId}`} className="h-28 w-full rounded object-cover" />
              ) : (
                <div className="flex h-28 items-center justify-center rounded bg-muted text-xs text-muted-foreground">no frame captured</div>
              )}
              <p className="mt-1 text-xs font-semibold">
                {i + 1}. {s.title}
              </p>
              <p className="text-xs text-muted-foreground">{actionLabel(s.decision.action)}</p>
            </a>
          </motion.li>
        );
      })}
    </ol>
  );
}

function StepCard({ step, data, proseLabel }: { step: WorkMapStep; data: WorkMapResponse; proseLabel: string }) {
  const moment = data.moments[step.id] ?? [];
  const frames = moment.filter((m) => m.mediaUrl !== null);
  const events = moment.filter((m) => m.mediaUrl === null);
  const clipHint = data.voiceSession ? "clip playback needs the recorded conversation audio (not retrieved yet)" : "audio clip requires a voice session";
  return (
    <Card id={step.id} data-testid="step" aria-label={`Step ${step.order + 1}`}>
      <CardHeader>
        <CardTitle className="flex flex-wrap items-center gap-2">
          <span>
            {step.order + 1}. {step.title}
          </span>
          <span className="text-xs font-normal text-muted-foreground" title={proseLabel}>
            ({data.proseOrigin === "llm" ? "LLM title" : "template title"})
          </span>
          <TraceButton entryId={step.decision.ledgerEntryId} label={`step ${step.order + 1}`} className="ml-auto" />
        </CardTitle>
      </CardHeader>
      <CardContent className="grid gap-3 md:grid-cols-[12rem_minmax(0,1fr)]">
        <div className="space-y-1">
          <p className="text-xs font-semibold text-muted-foreground uppercase">Screen moment</p>
          {frames[0] ? (
            <img src={frames[0].mediaUrl ?? ""} alt="Redacted frame" className="w-full rounded border" />
          ) : (
            <div className="flex h-24 items-center justify-center rounded bg-muted text-xs text-muted-foreground">no frame captured</div>
          )}
          <ul className="space-y-0.5 text-xs text-muted-foreground">
            {events.map((m) => (
              <li key={m.entryId}>
                {m.kind === "dom_event" ? "DOM" : "vision"}: {m.summary}
              </li>
            ))}
          </ul>
        </div>
        <div className="space-y-2">
          <p>
            <span className="text-muted-foreground">Decision ({step.caseId}):</span> <strong>{actionLabel(step.decision.action)}</strong>
          </p>
          {step.reasonQuotes.length === 0 && <p className="text-sm text-destructive">Not explained by a confirmed rule.</p>}
          {step.reasonQuotes.map((q) => (
            <div key={`${q.utteranceId}-${q.exactQuote}`} className="flex items-start gap-2" data-testid="reason-quote">
              <span title={clipHint}>
                <Button type="button" size="icon-xs" variant="outline" disabled aria-label={`Play clip: ${clipHint}`}>
                  <Play />
                </Button>
              </span>
              <blockquote className="flex-1 border-l-2 pl-2 italic">“{q.exactQuote}”</blockquote>
              <TraceButton entryId={q.utteranceId} label="expert quote" />
            </div>
          ))}
          {step.ruleIds.map((id) => (
            <p key={id} className="text-sm">
              <span className="text-muted-foreground">Rule:</span> when {data.ruleText[id]?.when} → {data.ruleText[id]?.then}{" "}
              <TraceButton entryId={data.ruleText[id]?.entryId ?? null} label={`rule ${id}`} />
            </p>
          ))}
          {step.guardrailIds.map((id) => (
            <p key={id} className="flex items-center gap-1 text-sm text-red-800" data-testid="guardrail">
              <ShieldAlert className="size-4" /> Guardrail: {data.ruleText[id]?.then} when {data.ruleText[id]?.when}
              <TraceButton entryId={data.ruleText[id]?.entryId ?? null} label={`guardrail ${id}`} />
            </p>
          ))}
        </div>
      </CardContent>
    </Card>
  );
}

function Exports({ data, sessionId }: { data: WorkMapResponse; sessionId: string }) {
  const origin = typeof window === "undefined" ? "" : window.location.origin;
  return (
    <Card aria-label="Exports">
      <CardHeader>
        <CardTitle>Exports</CardTitle>
        <p className="text-xs text-muted-foreground">Deterministic, compiled from the confirmed rules; both round-trip against them.</p>
      </CardHeader>
      <CardContent className="space-y-2 text-sm">
        <div className="flex flex-wrap gap-2">
          <Button asChild size="sm" variant="outline">
            <a href={exportUrl(sessionId, "json")} download>
              <Download /> Work Map JSON
            </a>
          </Button>
          <Button asChild size="sm" variant="outline">
            <a href={exportUrl(sessionId, "procedure")} download>
              <Download /> ElevenLabs Procedure
            </a>
          </Button>
        </div>
        <div className="rounded-md bg-muted p-2" data-testid="mcp-info">
          <p className="font-medium">MCP guardrail for agents</p>
          <p className="font-mono text-xs break-all">
            POST {origin}
            {data.mcp.path} · tool {data.mcp.tool} · rulebook revision {data.mcp.rulebookRevision}
          </p>
          <p className="text-xs text-muted-foreground">{data.mcp.bearerRequired ? "Requires Authorization: Bearer <MCP_BEARER_TOKEN>." : "No bearer token configured (open in development, refused in production)."}</p>
        </div>
      </CardContent>
    </Card>
  );
}
