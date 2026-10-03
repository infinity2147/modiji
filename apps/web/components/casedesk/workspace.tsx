"use client";

import Link from "next/link";
import { AlertCircle, FolderOpen, RotateCw } from "lucide-react";
import type { DomChannelStatus } from "@/lib/client/dom-events";
import { describeError } from "@/lib/client/api";
import type { SessionRef } from "@/lib/client/session-url";
import { Alert, AlertAction, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { CaseDetail } from "./case-detail";
import { CaseQueue } from "./case-queue";
import { InterlockDialog } from "./interlock-dialog";
import { ReviewPanel } from "./review-panel";
import { useWorkspace } from "./use-workspace";

function ChannelStatus({ channel }: { channel: DomChannelStatus }) {
  const text =
    channel.state === "idle"
      ? "All DOM events delivered"
      : channel.state === "sending"
        ? `Sending ${channel.pending} DOM event${channel.pending === 1 ? "" : "s"}…`
        : channel.state === "retryable_error"
          ? `${channel.pending} DOM event${channel.pending === 1 ? "" : "s"} waiting — delivery retries on the next action`
          : "DOM event capture stopped";
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
 * The CaseDesk working view: queue | case file | review. The grid keeps a `strip` row under the
 * three columns for the later event ticker / compliance strip; nothing is rendered there yet.
 */
export function Workspace({ session }: { session: SessionRef }) {
  const ws = useWorkspace(session);
  const stopped = ws.channel.state === "stopped";

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
    <>
      <ChannelStopped channel={ws.channel} />
      <div className="grid min-h-0 flex-1 grid-cols-[18rem_minmax(0,1fr)_20rem] grid-rows-[minmax(0,1fr)_auto] [grid-template-areas:'queue_detail_review'_'strip_strip_strip'] 2xl:grid-cols-[20rem_minmax(0,1fr)_22rem]">
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

        <div className="grid min-h-0 content-start gap-2 overflow-y-auto border-l bg-muted/30 p-3 [grid-area:review]">
          {selected && (
            <ReviewPanel
              kycCase={selected}
              draft={ws.draftFor(selected)}
              decision={ws.decisions.get(selected.id)}
              fresh={ws.lastCommitted === selected.id}
              saveState={ws.saveState}
              locked={stopped}
              onRiskRating={(rating) => ws.setRiskRating(selected, rating)}
              onOutcome={(action) => ws.setOutcome(selected, action)}
              onSave={() => ws.saveCase(selected)}
            />
          )}
          {ws.load.status === "ready" && <ChannelStatus channel={ws.channel} />}
        </div>
      </div>
      <InterlockDialog prompt={ws.prompt} onResolve={ws.resolvePrompt} onDismiss={ws.dismissPrompt} />
    </>
  );
}
