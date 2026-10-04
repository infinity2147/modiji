"use client";

/**
 * Verified replay mode (plan §10–12, P11): a genuine recorded run, re-rendered through the live UI's
 * components and driven by a virtual clock over its ledger entries. Every derived element comes from the
 * recorded entries: ticker lines and the compliance strip by the live client functions, CaseDesk by the
 * live resume fold, the HUD from the recorded gate entries, and the debrief, Work Map and tutor by the
 * live server derivations over the replayed prefix. Nothing is written and no model or voice is called.
 */
import { useMemo, useState } from "react";
import Link from "next/link";
import { AlertOctagon, CheckCircle2, Loader2, XCircle } from "lucide-react";
import type { LedgerEntry } from "@vashistha/core";
import { replayCaseDesk, generatedCaseIds } from "@/lib/client/replay/casedesk";
import { focusOf, type ReplayTab } from "@/lib/client/replay/follow";
import { replayHud } from "@/lib/client/replay/hud";
import type { ReplayBundleResponse, ReplayViewsResponse } from "@/lib/contracts/replay";
import { cn } from "@/lib/utils";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { ComplianceStrip } from "@/components/judge/compliance-strip";
import { EventTicker } from "@/components/judge/event-ticker";
import { HudDisplay } from "@/components/judge/hud-bar";
import { WorkMapBody } from "@/components/workmap/workmap-view";
import { ReplayBanner, hostOf } from "./replay-banner";
import { ReplayCaseDeskView } from "./replay-casedesk";
import { RecordedAudio } from "./recorded-audio";
import { ReplayDebrief } from "./replay-debrief";
import { Transport } from "./transport";
import { useBundle, useClock, useReplayViews } from "./use-replay";

export function ReplayPlayer({ bundleId }: { bundleId: string }) {
  const load = useBundle(bundleId);
  if (load.status === "loading")
    return (
      <main className="grid h-dvh place-items-center text-sm text-muted-foreground" role="status">
        <p className="flex items-center gap-2">
          <Loader2 className="size-4 animate-spin" /> Verifying recorded run {bundleId}…
        </p>
      </main>
    );
  if (load.status !== "ready")
    return (
      <main className="grid h-dvh place-items-center p-6">
        <Alert variant="destructive" className="max-w-2xl" data-testid="replay-refused">
          <AlertOctagon />
          <AlertTitle>
            {load.status === "refused" ? "REPLAY REFUSED — integrity check failed" : load.status === "missing" ? "No such recorded run" : "Could not load the recorded run"}
          </AlertTitle>
          <AlertDescription>
            {load.status === "refused" && (
              <>
                <p data-testid="replay-refused-reason">{load.detail}</p>
                <p>Nothing from this bundle is shown: a replay plays only when every file and the whole hash chain verify.</p>
              </>
            )}
            {load.status === "missing" && <p>Bundle {bundleId} is not on this server.</p>}
            {load.status === "error" && <p>{load.message}</p>}
            <p className="mt-2 flex gap-3">
              <Link className="underline" href="/replay">
                Recorded runs
              </Link>
              <Link className="underline" href="/sandbox">
                Try live
              </Link>
            </p>
          </AlertDescription>
        </Alert>
      </main>
    );
  return <ReplayStage data={load.data} />;
}

const DEBRIEF_LABEL: Record<ReplayTab, string> = { casedesk: "CaseDesk", debrief: "Debrief", workmap: "Work Map" };

function ReplayStage({ data }: { data: ReplayBundleResponse }) {
  const { manifest, entries } = data;
  const times = useMemo(() => entries.map((e) => e.receivedAt), [entries]);
  const clock = useClock(times);
  const views = useReplayViews(manifest.bundleId, clock.n);
  const modeOf = useMemo(() => {
    const modes = new Map(manifest.sessions.map((s) => [s.id, s.mode]));
    return (id: string) => modes.get(id);
  }, [manifest.sessions]);
  const generated = useMemo(() => {
    const out = new Map<string, Set<string>>();
    for (const s of manifest.sessions) out.set(s.id, generatedCaseIds(entries.filter((e) => e.sessionId === s.id)));
    return out;
  }, [entries, manifest.sessions]);

  const [follow, setFollow] = useState(true);
  const [manual, setManual] = useState<{ sessionId: string; tab: ReplayTab }>({ sessionId: manifest.sessions[0]?.id ?? "", tab: "casedesk" });
  const prefix = useMemo(() => entries.slice(0, clock.n), [entries, clock.n]);
  const current = prefix.at(-1);
  const focus = follow && current !== undefined ? focusOf(current, modeOf) : manual;
  const session = manifest.sessions.find((s) => s.id === focus.sessionId) ?? manifest.sessions[0];
  const tab: ReplayTab = session?.mode === "novice" ? "casedesk" : focus.tab;
  const sessionPrefix = useMemo(() => prefix.filter((e) => e.sessionId === session?.id), [prefix, session?.id]);
  const hud = useMemo(() => replayHud(sessionPrefix), [sessionPrefix]);
  const ledger = useMemo(() => ({ entries: prefix, caughtUp: true, error: undefined }), [prefix]);

  const choose = (sessionId: string, next: ReplayTab): void => {
    setFollow(false);
    setManual({ sessionId, tab: next });
  };

  return (
    <div className="flex h-dvh min-h-0 flex-col overflow-hidden">
      <ReplayBanner data={data} />
      <Transport clock={clock} entries={entries} firstAt={manifest.timeline.firstAt} />
      <nav aria-label="Recorded views" className="flex shrink-0 flex-wrap items-center gap-1 border-b bg-muted/40 px-4 py-1.5 text-xs">
        {manifest.sessions.map((s, i) => (
          <div key={s.id} className="flex items-center gap-1">
            <span className="text-muted-foreground">
              {i + 1}. {s.mode === "expert" ? `Expert${s.expert?.name === undefined ? "" : ` (${s.expert.name})`}` : "Novice"} · {s.caseSet}
            </span>
            {(s.mode === "expert" ? (["casedesk", "debrief", "workmap"] as const) : (["casedesk"] as const)).map((t) => (
              <Button
                key={t}
                size="xs"
                variant={session?.id === s.id && tab === t ? "default" : "ghost"}
                aria-pressed={session?.id === s.id && tab === t}
                onClick={() => choose(s.id, t)}
              >
                {t === "casedesk" && s.mode === "novice" ? "CaseDesk + tutor" : DEBRIEF_LABEL[t]}
              </Button>
            ))}
            <span aria-hidden className="mx-1 h-4 w-px bg-border" />
          </div>
        ))}
        <span className="ml-auto" />
        <RecordedAudio manifest={manifest} prefix={prefix} />
        <label className="flex items-center gap-1">
          <input type="checkbox" checked={follow} onChange={(e) => setFollow(e.currentTarget.checked)} />
          Follow the recording
        </label>
        <ViewsStatus pending={views.pending} error={views.error} views={views.views} n={clock.n} />
      </nav>

      <div className="flex min-h-0 flex-1 flex-col overflow-hidden" data-testid="replay-view" data-tab={tab} data-session={session?.id}>
        {session === undefined ? null : tab === "casedesk" ? (
          <CaseDeskTab data={data} sessionId={session.id} mode={session.mode} prefix={sessionPrefix} generated={generated.get(session.id) ?? new Set()} views={views.views} />
        ) : (
          <div className="min-h-0 flex-1 overflow-y-auto px-4 py-4">
            <ServerView sessionId={session.id} tab={tab} views={views.views} />
          </div>
        )}
      </div>

      <section aria-label="Judge view (recorded)" className="flex shrink-0 flex-col border-t bg-card">
        <div className="bg-slate-900">
          <HudDisplay status={hud.status} judge={hud.judge} value={hud.value} reason={hud.reason} />
        </div>
        <div className="grid h-32 min-h-0 border-b">
          <EventTicker ledger={ledger} caption={`recorded ledger · ${manifest.sessions.length} session(s) · replay`} />
        </div>
        <ComplianceStrip entries={prefix} />
        <CrossCheck views={views.views} total={entries.length} n={clock.n} source={hostOf(manifest.source.baseUrl)} />
      </section>
    </div>
  );
}

function ViewsStatus({ pending, error, views, n }: { pending: boolean; error: string | undefined; views: ReplayViewsResponse | null; n: number }) {
  if (error !== undefined) return <span className="text-destructive">Derived views unavailable: {error}</span>;
  const stale = views === null || views.n !== n;
  return (
    <span className="flex items-center gap-1 text-muted-foreground" data-testid="views-status" data-n={views?.n ?? -1} data-through={views?.derivedThrough ?? -1}>
      {pending || stale ? <Loader2 className="size-3 animate-spin" /> : null}
      {views === null
        ? "deriving views…"
        : `views derived from entries 1–${views.derivedThrough}${views.derivedThrough > views.n ? " (end of that recorded write)" : ""} (${views.deriveMs} ms)`}
    </span>
  );
}

function CaseDeskTab({
  data,
  sessionId,
  mode,
  prefix,
  generated,
  views,
}: {
  data: ReplayBundleResponse;
  sessionId: string;
  mode: "expert" | "novice";
  prefix: readonly LedgerEntry[];
  generated: ReadonlySet<string>;
  views: ReplayViewsResponse | null;
}) {
  const desk = useMemo(() => replayCaseDesk(prefix, data.cases[sessionId] ?? [], generated), [prefix, data.cases, sessionId, generated]);
  if (desk === null) return <p className="p-6 text-sm text-muted-foreground">This session had not started at this point of the recording.</p>;
  return <ReplayCaseDeskView desk={desk} mode={mode} tutorState={views?.sessions[sessionId]?.tutor ?? null} />;
}

function ServerView({ sessionId, tab, views }: { sessionId: string; tab: ReplayTab; views: ReplayViewsResponse | null }) {
  const v = views?.sessions[sessionId];
  if (v === undefined) return <p className="text-sm text-muted-foreground">Deriving this view from the recorded entries…</p>;
  if (tab === "debrief" && v.debrief !== null) return <ReplayDebrief state={v.debrief} />;
  if (tab === "workmap" && v.workmap !== null)
    return (
      <fieldset disabled aria-label="Recorded Work Map (read-only)" className="min-w-0 space-y-4">
        <p className="text-xs text-muted-foreground">
          {v.workmap.workMap.id} · rulebook revision {v.workmap.workMap.rulebookRevision} · built by code from the recorded ledger · step titles and summary are the
          deterministic templates in replay (no model is called)
        </p>
        <WorkMapBody data={v.workmap} sessionId={sessionId} exports={false} />
      </fieldset>
    );
  return <p className="text-sm text-muted-foreground">{v.note ?? "Nothing to show at this point of the recording."}</p>;
}

function CrossCheck({ views, total, n, source }: { views: ReplayViewsResponse | null; total: number; n: number; source: string }) {
  if (views === null || views.derivedThrough !== total || n !== views.n || views.crossCheck.length === 0) return null;
  const all = views.crossCheck.every((c) => c.match);
  return (
    <div
      role="status"
      data-testid="replay-cross-check"
      data-match={all}
      className={cn("flex flex-wrap items-center gap-2 border-t px-3 py-1 text-xs", all ? "bg-emerald-50 text-emerald-900" : "bg-amber-50 text-amber-900")}
    >
      {all ? <CheckCircle2 className="size-3.5" /> : <XCircle className="size-3.5" />}
      End of recording: the replay&apos;s derivation {all ? "matches" : "differs from"} the views {source} served at export
      {views.crossCheck.map((c) => (
        <span key={`${c.sessionId}-${c.view}`} className="font-mono" title={c.differences.join("\n")}>
          {c.view} {c.match ? "✓" : `✗ (${c.differences.length})`}
        </span>
      ))}
    </div>
  );
}
