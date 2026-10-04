"use client";

import { useEffect, useRef, useState, type ReactNode } from "react";
import type { UserRole } from "@vashistha/core";
import type { KycCase } from "@vashistha/core/domains/kyc";
import Link from "next/link";
import { ConversationProvider } from "@elevenlabs/react";
import { AlertCircle, FolderOpen, RotateCw } from "lucide-react";
import { attachActivitySensors } from "@/lib/client/gate/activity";
import { PrivacyContext, useInterviewLoop, type GateSensors } from "@/lib/client/voice/use-interview";
import type { DomChannelStatus } from "@/lib/client/dom-events";
import { describeError } from "@/lib/client/api";
import type { SessionRef } from "@/lib/client/session-url";
import { useTutor, type Tutor } from "@/lib/client/tutor/use-tutor";
import { Alert, AlertAction, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { ScreenCaptureCard } from "@/components/capture/screen-capture";
import { JudgeView } from "@/components/judge/judge-view";
import { OffRecordBanner } from "@/components/voice/off-record";
import { VoicePanel } from "@/components/voice/voice-panel";
import { NoviceReview } from "@/components/tutor/novice-review";
import { TraineeGuide, guideStage } from "@/components/tutor/trainee-guide";
import { TutorPanels } from "@/components/tutor/tutor-panels";
import { CaseDetail } from "./case-detail";
import { CaseQueue } from "./case-queue";
import { InterlockDialog } from "./interlock-dialog";
import { ReviewPanel } from "./review-panel";
import { useWorkspace, type Draft } from "./use-workspace";
import { WorkflowTracker, expertSteps, noviceSteps } from "./workflow-tracker";

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

/** In novice sessions the review panel sits inside the tutor's predict-then-reveal flow; experts see it as is. */
function NoviceReviewSlot({
  novice,
  tutor,
  kycCase,
  draft,
  locked,
  agentConnected,
  children,
}: {
  novice: boolean;
  tutor: Tutor;
  kycCase: KycCase;
  draft: Draft;
  locked: boolean;
  /** The tutor voice agent is connected (it speaks interventions; the browser voice stays silent). */
  agentConnected: boolean;
  children: ReactNode;
}) {
  if (!novice) return children;
  return (
    <NoviceReview key={kycCase.id} tutor={tutor} kycCase={kycCase} outcome={draft.outcome} riskRating={draft.riskRating} locked={locked} agentConnected={agentConnected}>
      {children}
    </NoviceReview>
  );
}

/**
 * The CaseDesk working view: queue | case file | review (+ voice panel), with the judge view (gate
 * HUD, event ticker, compliance strip) in the full-width row underneath. The voice conversation lives
 * in `ConversationProvider`; everything else works without it.
 */
export function Workspace({ session, role }: { session: SessionRef; role: UserRole }) {
  return (
    <ConversationProvider>
      <WorkspaceBody session={session} role={role} />
    </ConversationProvider>
  );
}

function WorkspaceBody({ session, role }: { session: SessionRef; role: UserRole }) {
  const sensors = useRef<GateSensors | null>(null);
  const ws = useWorkspace(session, sensors);
  const [screenShared, setScreenShared] = useState(false);
  const loop = useInterviewLoop({
    sessionId: session.sessionId,
    mode: session.mode,
    privacyInit: ws.load.status === "ready" ? ws.load.privacy : undefined,
    // The interviewer listens and speaks in the expert's declared language (plan §7.11).
    ...(ws.load.status === "ready" && { language: ws.load.expertLanguage }),
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
  const novice = session.mode === "novice";
  const tutor = useTutor(session.sessionId, novice);
  // The ledger grew (an intervention spoken, a decision committed, a mastery change): re-read the tutor view.
  const ledgerSize = loop.ledger.entries.length;
  const refreshTutor = tutor.refresh;
  useEffect(() => {
    if (ledgerSize > 0) refreshTutor();
  }, [ledgerSize, refreshTutor]);

  // A trainee should never face an empty screen: the first open case is opened for them.
  const loadedCases = ws.load.status === "ready" ? ws.load.cases : undefined;
  const nothingSelected = ws.selectedCase === undefined;
  const openCase = ws.openCase;
  const decidedIds = ws.decisions;
  useEffect(() => {
    if (!novice || !loadedCases || !nothingSelected) return;
    const first = loadedCases.find((c) => !decidedIds.has(c.id)) ?? loadedCases[0];
    if (first) openCase(first.id);
  }, [novice, loadedCases, nothingSelected, decidedIds, openCase]);

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
      {ws.load.status === "ready" && (
        <WorkflowTracker
          steps={
            novice
              ? noviceSteps({ opened: ws.selectedCase !== undefined, decided: ws.selectedCase !== undefined && ws.decisions.has(ws.selectedCase.id) })
              : expertSteps({ decided: ws.decisions.size, total: ws.load.cases.length, queued: loop.gate?.queue.length ?? 0, sessionId: session.sessionId })
          }
        />
      )}
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
          {novice && ws.load.status === "ready" && (
            <TraineeGuide
              stage={guideStage({ state: tutor.state, hasSelected: selected !== undefined, decided: ws.decisions.size, total: ws.load.cases.length })}
              rules={tutor.state?.rules.length ?? 0}
              decided={ws.decisions.size}
              total={ws.load.cases.length}
            />
          )}
          {novice ? (
            <details className="group rounded-2xl border bg-card">
              <summary className="cursor-pointer list-none px-4 py-3 text-sm font-semibold marker:hidden">
                Voice coach <span className="font-normal text-muted-foreground">(optional: text coaching is already on)</span>
              </summary>
              <div className="border-t p-2">
                <VoicePanel loop={loop} />
              </div>
            </details>
          ) : (
            <VoicePanel loop={loop} />
          )}
          {selected && (
            <NoviceReviewSlot novice={novice} tutor={tutor} kycCase={selected} draft={ws.draftFor(selected)} locked={stopped || offRecord} agentConnected={loop.voice.state === "connected"}>
              <ReviewPanel
                kycCase={selected}
                draft={ws.draftFor(selected)}
                decision={ws.decisions.get(selected.id)}
                fresh={ws.lastCommitted === selected.id}
                saveState={ws.saveState}
                locked={stopped || offRecord}
                onRiskRating={(rating) => ws.setRiskRating(selected, rating)}
                onOutcome={(action) => {
                  ws.setOutcome(selected, action);
                  // The tutor's DOM-channel signal: the guardrail monitor checks the selection before Save.
                  if (novice) tutor.intent(selected.id, action, ws.draftFor(selected).riskRating);
                }}
                onSave={() => ws.saveCase(selected)}
              />
            </NoviceReviewSlot>
          )}
          {novice && ws.load.status === "ready" && <TutorPanels tutor={tutor} onCases={ws.addCases} canEnterJudgeCase={role === "admin"} />}
          {ws.load.status === "ready" && <ChannelStatus channel={ws.channel} />}
          {!novice && ws.load.status === "ready" && <ScreenCaptureCard sessionId={session.sessionId} cases={ws.load.cases} onSharingChange={setScreenShared} />}
        </div>

        {/* The gate HUD, event ticker and compliance strip are expert and judge instruments: a trainee works without them. */}
        <div className="min-h-0 [grid-area:strip]">{(!novice || role === "admin") && <JudgeView sessionId={session.sessionId} loop={loop} />}</div>
      </div>
      <InterlockDialog prompt={ws.prompt} onResolve={ws.resolvePrompt} onDismiss={ws.dismissPrompt} />
    </PrivacyContext>
  );
}
