"use client";

import { useEffect } from "react";
import type { KycCase } from "@vashistha/core/domains/kyc";
import { MonitorUp, MonitorX, ScanEye } from "lucide-react";
import type { CaptureStats, CaptureStatus, Latency } from "@/lib/client/capture/pipeline";
import type { VisionState } from "@/lib/contracts/frames";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader } from "@/components/ui/card";
import { Pill, type Tone } from "@/components/casedesk/pills";
import { useScreenCapture } from "./use-screen-capture";

/** The disclosure shown next to the control: the whole and only claim about frame privacy. */
export const SCREEN_CAPTURE_DISCLOSURE = "Screen frames: change-detected, best-effort PII blur in your browser before upload";

function statusPill(status: CaptureStatus | null): { tone: Tone; text: string } {
  switch (status?.state) {
    case undefined:
      return { tone: "neutral", text: "Loading…" };
    case "idle":
      return { tone: "neutral", text: "Not sharing" };
    case "capturing":
      return { tone: "danger", text: "Capturing" };
    case "off_record":
      return { tone: "warning", text: "Paused — off the record" };
    case "stopped":
      return { tone: "danger", text: "Stopped" };
  }
}

function visionText(vision: VisionState | null): string {
  if (vision === null) return "Vision: no frame uploaded yet";
  if (vision.extraction === "unavailable")
    return vision.unavailableReason === "disabled"
      ? "Vision unavailable (disabled on this server) — frames are stored, no vision events are extracted"
      : "Vision unavailable (no API key) — frames are stored, no vision events are extracted";
  const p95 = vision.latencyMs.captureToEvents.p95;
  return `Vision: ${vision.counts.events} events from ${vision.counts.applied} frames${p95 === null ? "" : ` · p95 frame→event ${Math.round(p95)} ms`}`;
}

const ms = (l: Latency): string => (l.n === 0 ? "—" : `${Math.round(l.p50 ?? 0)} / ${Math.round(l.p95 ?? 0)} ms`);

function Stats({ stats }: { stats: CaptureStats }) {
  const v = stats.vision;
  const rows: Array<[string, string]> = [
    ["Frames captured / changed", `${stats.captured} / ${stats.changed}`],
    ["Uploaded / coalesced", `${stats.uploaded} / ${stats.coalesced}`],
    ["Stale-dropped / cancelled", `${stats.staleDropped} / ${stats.cancelled}`],
    ["Skipped (busy) / redaction failed", `${stats.skippedBusy} / ${stats.redactionFailed}`],
    ["PII regions blurred", String(stats.redactedRegions)],
    ["OCR + blur p50 / p95", ms(stats.ocrMs)],
    ["Upload p50 / p95", ms(stats.uploadMs)],
  ];
  if (v !== null && v.extraction === "available")
    rows.push(
      ["Server extracted / coalesced / stale", `${v.counts.applied} / ${v.counts.coalesced} / ${v.counts.staleDropped}`],
      ["Frame→event p50 / p95", ms(v.latencyMs.captureToEvents)],
    );
  return (
    <details className="text-[11px]">
      <summary className="cursor-pointer text-muted-foreground select-none">Perception stats</summary>
      <dl aria-label="Perception stats" className="mt-1.5 grid grid-cols-[1fr_auto] gap-x-3 gap-y-0.5">
        {rows.map(([label, value]) => (
          <div key={label} className="contents">
            <dt className="text-muted-foreground">{label}</dt>
            <dd className="text-right font-mono tabular-nums">{value}</dd>
          </div>
        ))}
      </dl>
    </details>
  );
}

/**
 * "Share screen": the vision channel's user control (plan §7.1). Marked `data-gate-ignore` so its own
 * updates (stats, indicator) never count as the expert's screen moving.
 */
export function ScreenCaptureCard({
  sessionId,
  cases,
  onSharingChange,
}: {
  sessionId: string;
  cases: readonly KycCase[];
  /** Told whether frames are being captured now (the expert interview needs a shared screen). */
  onSharingChange: (sharing: boolean) => void;
}) {
  const capture = useScreenCapture(sessionId, cases);
  const { status, stats } = capture;
  const pill = statusPill(status);
  const capturing = status?.state === "capturing";
  useEffect(() => onSharingChange(capturing), [capturing, onSharingChange]);
  return (
    <Card data-gate-ignore="" className="gap-0 py-0 shadow-xs" role="region" aria-labelledby="capture-title">
      <CardHeader className="flex flex-row items-center justify-between gap-2 border-b py-2.5!">
        <h2 id="capture-title" className="flex items-center gap-2 text-sm font-semibold">
          <ScanEye aria-hidden className="size-3.5 text-muted-foreground" />
          Screen capture
        </h2>
        <span role="status" aria-label="Screen capture status">
          <Pill tone={pill.tone} className={capturing ? "animate-pulse" : undefined}>
            {pill.text}
          </Pill>
        </span>
      </CardHeader>
      <CardContent className="grid gap-2.5 py-3">
        <p className="text-[11px] leading-snug text-muted-foreground">{SCREEN_CAPTURE_DISCLOSURE}.</p>
        {capturing ? (
          <Button variant="outline" size="sm" onClick={capture.stop}>
            <MonitorX data-icon="inline-start" />
            Stop sharing
          </Button>
        ) : (
          <Button size="sm" onClick={capture.share} disabled={status === null || status.state === "off_record"}>
            <MonitorUp data-icon="inline-start" />
            Share screen
          </Button>
        )}
        {status?.state === "stopped" && (
          <p role="alert" className="text-xs text-destructive">
            Capture stopped: {status.error}
          </p>
        )}
        {capture.error !== undefined && (
          <p role="alert" className="text-xs text-destructive">
            {capture.error}
          </p>
        )}
        {stats !== null && (
          <>
            <p aria-label="Vision status" className="text-[11px] text-muted-foreground">
              {visionText(stats.vision)}
            </p>
            <Stats stats={stats} />
          </>
        )}
      </CardContent>
    </Card>
  );
}
