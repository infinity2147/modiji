"use client";

import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import { ConversationProvider } from "@elevenlabs/react";
import { AlertCircle, FolderOpen, RotateCw } from "lucide-react";
import { attachActivitySensors } from "@/lib/client/gate/activity";
import { PrivacyContext, useInterviewLoop, type GateSensors } from "@/lib/client/voice/use-interview";
import type { DomChannelStatus } from "@/lib/client/dom-events";
import { describeError } from "@/lib/client/api";
import type { SessionRef } from "@/lib/client/session-url";
import { Alert, AlertAction, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { ScreenCaptureCard } from "@/components/capture/screen-capture";
import { JudgeView } from "@/components/judge/judge-view";
import { OffRecordBanner } from "@/components/voice/off-record";
import { VoicePanel } from "@/components/voice/voice-panel";
import { CaseDetail } from "./case-detail";
import { CaseQueue } from "./case-queue";
import { InterlockDialog } from "./interlock-dialog";
import { ReviewPanel } from "./review-panel";
import { useWorkspace } from "./use-workspace";

function channelText(channel: DomChannelStatus): string {
  switch (channel.state) {
    case "idle":
      return "All DOM events delivered";
    case "sending":
      return `Sending ${channel.pending} DOM event${channel.pending === 1 ? "" : "s"}…`;
    case "retryable_error":
      return `${channel.pending} DOM event${channel.pending === 1 ? "" : "s"} waiting — delivery retries on the next action`;
    case "paused":
      return "DOM event capture paused — off the record";
    case "stopped":
      return "DOM event capture stopped";
  }
}

function ChannelStatus({ channel }: { channel: DomChannelStatus }) {
  const text = channelText(channel);
  return (
    <p role="status" aria-live="polite" className="px-1 text-[11px] text-muted-foreground">
      {text}
    </p>
  );
}

function ChannelStopped({ channel }: { channel: DomChannelStatus }) {
  if (channel.state !== "stopped") return null;
  return (
    <Alert variant="destructive" className="rounded-none border-x-0 border-t-0">
      <AlertCircle />
      <AlertTitle>Event capture stopped — the server refused DOM events</AlertTitle>
      <AlertDescription>
        {describeError(channel.error)}. Saving is disabled for this session because the ledger would be incomplete.
      </AlertDescription>
      <AlertAction>
        <Button asChild size="xs" variant="outline">
          <Link href="/sandbox">Start a new session</Link>
        </Button>
      </AlertAction>
    </Alert>
  );
}

function LoadingQueue() {
  return (
    <div aria-busy="true" aria-label="Loading cases" className="grid flex-1 content-start gap-3 border-r bg-card p-4">
      {[0, 1, 2].map((i) => (
        <div key={i} className="grid gap-2">
          <Skeleton className="h-3 w-24" />
          <Skeleton className="h-4 w-48" />
          <Skeleton className="h-3 w-36" />
        </div>
      ))}
    </div>
  );
}

/**
 * The CaseDesk working view: queue | case file | review (+ voice panel), with the judge view (gate
 * HUD, event ticker, compliance strip) in the full-width row underneath. The voice conversation lives
 * in `ConversationProvider`; everything else works without it.
 */
export function Workspace({ session }: { session: SessionRef }) {
  return (
    <ConversationProvider>
      <WorkspaceBody session={session} />
    </ConversationProvider>
  );
}

function WorkspaceBody({ session }: { session: SessionRef }) {
  const sensors = useRef<GateSensors | null>(null);
  const ws = useWorkspace(session, sensors);
  const [screenShared, setScreenShared] = useState(false);
  const loop = useInterviewLoop({
    sessionId: session.sessionId,
    mode: session.mode,
    privacyInit: ws.load.status === "ready" ? ws.load.privacy : undefined,
    capture: ws.capture,
    // Reported by the Screen capture card (components/capture): true only while frames are being captured.
    screenShared,
  });
  const caseArea = useRef<HTMLDivElement>(null);
  const loopSensors = loop.sensors;
  useEffect(() => {
    sensors.current = loopSensors;
  });
  const sensing = ws.load.status === "ready";
  useEffect(() => {
    const root = caseArea.current;
    if (!root || !sensing) return;
    return attachActivitySensors(root, {
      typing: () => sensors.current?.typing(),
      screenMotion: () => sensors.current?.screenMotion(),
    });
  }, [sensing]);

  const stopped = ws.channel.state === "stopped";
  const offRecord = loop.privacyState?.offRecord ?? false;

  if (ws.load.status === "error") {
    return (
      <main className="grid flex-1 place-items-center p-6">
        <Alert variant="destructive" className="max-w-lg">
          <AlertCircle />
          <AlertTitle>Could not open this session</AlertTitle>
          <AlertDescription>{ws.load.message}</AlertDescription>
          <div className="col-start-2 mt-3 flex gap-2">
            <Button size="sm" variant="outline" onClick={ws.retryLoad}>
              <RotateCw data-icon="inline-start" />
              Try again
            </Button>
            <Button asChild size="sm" variant="ghost">
              <Link href="/sandbox">Start a new session</Link>
            </Button>
          </div>
        </Alert>
      </main>
    );
  }

  const selected = ws.selectedCase;
  return (
    <PrivacyContext value={loop.privacy}>
      <OffRecordBanner state={loop.privacyState} />
      <ChannelStopped channel={ws.channel} />
      <div ref={caseArea} className="grid min-h-0 flex-1 grid-cols-[18rem_minmax(0,1fr)_20rem] grid-rows-[minmax(0,1fr)_auto] [grid-template-areas:'queue_detail_review'_'strip_strip_strip'] 2xl:grid-cols-[20rem_minmax(0,1fr)_22rem]">
        <div className="flex min-h-0 flex-col [grid-area:queue]">
          {ws.load.status === "ready" ? (
            <CaseQueue
              cases={ws.load.cases}
              decisions={ws.decisions}
              selectedId={selected?.id}
              lastCommitted={ws.lastCommitted}
              onOpen={ws.openCase}
            />
          ) : (
            <LoadingQueue />
          )}
        </div>

        <main className="min-h-0 overflow-y-auto p-4 [grid-area:detail]">
          {selected ? (
            <CaseDetail kycCase={selected} />
          ) : (
            ws.load.status === "ready" && (
              <div className="grid h-full place-items-center">
                <div className="grid justify-items-center gap-2 text-center text-sm text-muted-foreground">
                  <FolderOpen aria-hidden className="size-6" />
                  <p>Select a case from the queue to open its file.</p>
                </div>
              </div>
            )
          )}
        </main>

        <div className="flex min-h-0 flex-col gap-2 overflow-y-auto border-l bg-muted/30 p-3 *:shrink-0 [grid-area:review]">
          <VoicePanel loop={loop} />
          {selected && (
            <ReviewPanel
              kycCase={selected}
              draft={ws.draftFor(selected)}
              decision={ws.decisions.get(selected.id)}
              fresh={ws.lastCommitted === selected.id}
              saveState={ws.saveState}
              locked={stopped || offRecord}
              onRiskRating={(rating) => ws.setRiskRating(selected, rating)}
              onOutcome={(action) => ws.setOutcome(selected, action)}
              onSave={() => ws.saveCase(selected)}
            />
          )}
          {ws.load.status === "ready" && <ChannelStatus channel={ws.channel} />}
          {ws.load.status === "ready" && <ScreenCaptureCard sessionId={session.sessionId} cases={ws.load.cases} onSharingChange={setScreenShared} />}
        </div>

        <div className="min-h-0 [grid-area:strip]">
          <JudgeView sessionId={session.sessionId} loop={loop} />
        </div>
      </div>
      <InterlockDialog prompt={ws.prompt} onResolve={ws.resolvePrompt} onDismiss={ws.dismissPrompt} />
    </PrivacyContext>
  );
}
