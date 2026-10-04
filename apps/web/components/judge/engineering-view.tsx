"use client";

import { useEffect, useState, useSyncExternalStore, type ReactNode } from "react";
import { AlertTriangle } from "lucide-react";
import { AUTHORIZATION_LATENCY_BOUND_MS, DEFAULT_GATE_CONFIG } from "@vashistha/core";
import type { GateSnapshot } from "@/lib/client/gate/gate-session";
import { describeError, type FetchFn } from "@/lib/client/api";
import { fetchEngineState, type EngineState } from "@/lib/client/judge/api";
import { percentiles } from "@/lib/client/judge/stats";
import { cn } from "@/lib/utils";

const ENGINE_POLL_MS = 2000;
const browserFetch: FetchFn = (input, init) => fetch(input, init);

type EngineView = { state: "loading" } | { state: "ok"; engine: EngineState } | { state: "error"; message: string };

/** Polls the engine state while the engineering view is open. */
function useEngineState(sessionId: string): EngineView {
  const [view, setView] = useState<EngineView>({ state: "loading" });
  useEffect(() => {
    let abort: AbortController | null = null;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let stopped = false;
    const read = (): void => {
      abort = new AbortController();
      const signal = abort.signal;
      fetchEngineState(browserFetch, sessionId, signal).then(
        (engine) => !signal.aborted && setView({ state: "ok", engine }),
        (error: unknown) => !signal.aborted && setView({ state: "error", message: describeError(error) }),
      ).finally(() => {
        if (!stopped) timer = setTimeout(read, ENGINE_POLL_MS);
      });
    };
    read();
    return () => {
      stopped = true;
      abort?.abort();
      clearTimeout(timer);
    };
  }, [sessionId]);
  return view;
}

function subscribeVisibility(listener: () => void): () => void {
  document.addEventListener("visibilitychange", listener);
  return () => document.removeEventListener("visibilitychange", listener);
}

function Panel({ title, children, className }: { title: string; children: ReactNode; className?: string }) {
  return (
    <section aria-label={title} className={cn("flex min-h-0 min-w-0 flex-col gap-1.5 overflow-y-auto", className)}>
      <h3 className="text-[11px] font-semibold tracking-wide text-muted-foreground uppercase">{title}</h3>
      {children}
    </section>
  );
}

const ms = (value: number): string => (Number.isFinite(value) ? `${Math.round(value)} ms` : "∞ (event)");

/** Full gate telemetry for engineers and judges who want to check the HUD's numbers (plan §7.2). */
export function EngineeringView({ sessionId, gate }: { sessionId: string; gate: GateSnapshot | null }) {
  const engine = useEngineState(sessionId);
  const visibility = useSyncExternalStore(subscribeVisibility, () => document.visibilityState, () => "visible");
  const latency = percentiles(gate?.latency.map((s) => s.latencyMs) ?? []);

  return (
    <div className="grid min-h-0 grid-cols-[minmax(0,1.1fr)_minmax(0,1fr)_minmax(0,1.2fr)_minmax(0,1.2fr)] gap-4 px-3 py-2 text-[11.5px]">
      <Panel title="Gate conditions (all 8)">
        {gate === null ? (
          <p className="text-muted-foreground">Starting…</p>
        ) : (
          <table className="w-full tabular-nums">
            <thead className="sr-only">
              <tr>
                <th>Condition</th>
                <th>State</th>
                <th>Wait</th>
              </tr>
            </thead>
            <tbody>
              {gate.hud.rows.map((row) => (
                <tr key={row.key}>
                  <td className="py-px pr-2">{row.label}</td>
                  <td className={cn("pr-2 font-medium", row.ok ? "text-emerald-700" : "text-amber-700")}>{row.ok ? "✓" : "wait"}</td>
                  <td className="text-right font-mono text-muted-foreground">
                    {row.ok ? "0 ms" : ms(gate.conditions[row.key].waitMs)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
        <p className="text-muted-foreground">
          Thresholds: silence {DEFAULT_GATE_CONFIG.userSilenceMs} ms · screen {DEFAULT_GATE_CONFIG.screenIdleMs} ms · typing{" "}
          {DEFAULT_GATE_CONFIG.typingIdleMs} ms · θ<sub>ask</sub> {DEFAULT_GATE_CONFIG.thetaAsk} bits · budget{" "}
          {DEFAULT_GATE_CONFIG.liveBudget.max}/{DEFAULT_GATE_CONFIG.liveBudget.windowMs / 60_000} min (live questions only: {DEFAULT_GATE_CONFIG.liveBudget.kinds.join(", ")})
        </p>
      </Panel>

      <Panel title="Latency · became valid → authorized">
        {latency === null ? (
          <p className="text-muted-foreground">No authorizations yet.</p>
        ) : (
          <p className="font-mono">
            p50 {latency.p50} ms · p95 {latency.p95} ms · n={latency.n}
          </p>
        )}
        <p className="text-muted-foreground">
          Bound {AUTHORIZATION_LATENCY_BOUND_MS} ms; samples include the authorize round trip. First-audio latency is measured separately.
        </p>
        <p
          role={visibility === "visible" ? undefined : "alert"}
          className={cn("flex items-start gap-1", visibility === "visible" ? "text-muted-foreground" : "text-amber-700")}
        >
          <AlertTriangle aria-hidden className="mt-px size-3 shrink-0" />
          Keep this tab in the foreground: browsers throttle background timers to ≥ 1 s, which breaks the 250 ms bound.
          {visibility !== "visible" && " (This tab is in the background now.)"}
        </p>
        <p className="text-muted-foreground">
          Gate sensing (timing only, not recorded): keystrokes anywhere in CaseDesk except the voice panel; scrolling and content changes in
          the case area; the microphone&apos;s level in this browser (speech onset, from the voice session&apos;s own input); voice activity,
          transcript arrival and agent mode from the voice provider.
        </p>
        {gate !== null && gate.refusals.length > 0 && (
          <>
            <h4 className="mt-1 font-medium">Refused or withdrawn authorizations</h4>
            <ul className="grid gap-0.5">
              {gate.refusals.map((r) => (
                <li key={`${r.questionId}-${r.at}`} className="text-amber-800">
                  <span className="font-mono">{r.code}</span> · {r.message}
                </li>
              ))}
            </ul>
          </>
        )}
      </Panel>

      <Panel title="Question queue">
        {gate === null || gate.queueStatus.state === "loading" ? (
          <p className="text-muted-foreground">Reading the queue…</p>
        ) : gate.queueStatus.state === "error" ? (
          <p className="text-destructive">Queue unavailable: {gate.queueStatus.message}</p>
        ) : gate.queue.length === 0 ? (
          <p className="text-muted-foreground">Empty · context v{gate.contextVersion} · {gate.serverAsked} asked</p>
        ) : (
          <>
            <p className="text-muted-foreground">
              Context v{gate.contextVersion} · {gate.serverAsked} asked this session
            </p>
            <ol className="grid gap-1">
              {gate.queue.map((q, i) => (
                <li key={q.id} className={cn("rounded px-1.5 py-1", i === 0 ? "bg-sky-50 ring-1 ring-sky-200 ring-inset" : "bg-muted/60")}>
                  <p className="font-mono">
                    {q.kind === "intervention" ? `priority ${q.value.toFixed(2)}` : `EIG ${q.value.toFixed(2)} bits`} · {q.kind}
                    {q.ephemeral && " · ephemeral"}
                  </p>
                  <p className="truncate" title={q.text}>
                    “{q.text}”
                  </p>
                  <p className="text-muted-foreground">{q.reason}</p>
                </li>
              ))}
            </ol>
          </>
        )}
      </Panel>

      <Panel title="Engine state">
        {engine.state === "loading" ? (
          <p className="text-muted-foreground">Reading the engine…</p>
        ) : engine.state === "error" ? (
          <p className="text-destructive">Engine unavailable: {engine.message}</p>
        ) : (
          <>
            <p className="font-mono">
              {engine.engine.confirmedRules} confirmed rule(s) · rulebook rev {engine.engine.rulebookRevision}
            </p>
            <p className="font-mono" data-testid="answer-parser">
              Answer parser: {engine.engine.answerParser.available ? "available" : "unavailable (no model)"} · unparsed answers{" "}
              <span className={engine.engine.answerParser.unparsedAnswers > 0 ? "text-destructive" : undefined}>{engine.engine.answerParser.unparsedAnswers}</span>
            </p>
            {engine.engine.families.map((f) => (
              <div key={f.decisionFamily} className="grid gap-0.5">
                <p className="font-medium">
                  {f.decisionFamily} · {f.observations} obs
                  {f.lastSurpriseBits !== null && ` · surprise ${f.lastSurpriseBits.toFixed(2)} bits`}
                </p>
                <ul className="grid gap-px">
                  {f.top.map((h) => (
                    <li key={h.candidateId} className="flex gap-2">
                      <span className="w-10 shrink-0 text-right font-mono tabular-nums">{h.weight.toFixed(2)}</span>
                      <span className="truncate" title={h.description}>
                        {h.description}
                      </span>
                    </li>
                  ))}
                </ul>
              </div>
            ))}
            <p className="text-muted-foreground">
              Undefined concepts:{" "}
              {engine.engine.undefinedConcepts.length === 0 ? "none" : engine.engine.undefinedConcepts.map((c) => c.label).join(", ")}
            </p>
            {engine.engine.mastery.length > 0 && (
              <p className="text-muted-foreground">
                Mastery: {engine.engine.mastery.map((m) => `${m.ruleId.slice(0, 8)} ${m.level}`).join(" · ")}
              </p>
            )}
          </>
        )}
      </Panel>
    </div>
  );
}
