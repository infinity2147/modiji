import Link from "next/link";
import { ClipboardCheck, Eye, Map, Plus } from "lucide-react";
import type { Viewer } from "@/lib/contracts/auth";
import type { SessionRef } from "@/lib/client/session-url";
import { AccountChip } from "@/components/auth/account-chip";
import { Logo } from "@/components/shell/sidebar-nav";
import { shortId } from "@/lib/client/format";
import { Button } from "@/components/ui/button";
import { MODE_LABELS, SET_LABELS } from "./labels";

/** Northstar Bank · CaseDesk header. Always states that the data is synthetic and how the app senses. */
export function TopBar({ session, viewer }: { session?: SessionRef | undefined; viewer: Viewer }) {
  return (
    <header className="flex h-12 shrink-0 items-center gap-4 border-b border-[#12393D] bg-[#0B2B2E] px-4 text-slate-100">
      <Link href="/home" aria-label="Back to Home" className="flex items-center gap-2.5 text-white">
        <Logo onDark />
      </Link>
      <span aria-hidden className="h-4 w-px bg-slate-700" />
      <h1 className="text-sm font-medium text-slate-300">CaseDesk</h1>
      <span className="rounded border border-amber-400/40 bg-amber-400/10 px-1.5 py-0.5 text-[11px] font-medium whitespace-nowrap text-amber-200">
        Synthetic data — fictional policy
      </span>

      <div className="ml-auto flex items-center gap-3 text-xs">
        <p
          className="flex items-center gap-1.5 text-slate-400"
          title="Sensing (disclosed): DOM events · typing & scroll timing · screen-frame case id read on-device by OCR · microphone only when voice is on"
        >
          <Eye aria-hidden className="size-3.5 shrink-0" />
          <span className="hidden 2xl:inline">Sensing (disclosed): DOM events · typing &amp; scroll timing · screen-frame case id read on-device by OCR · microphone only when voice is on</span>
          <span className="2xl:hidden">Sensing disclosed (hover)</span>
        </p>
        {session && (
          <>
            <span aria-hidden className="h-4 w-px bg-slate-700" />
            <p
              aria-label="Session"
              className="flex items-center gap-2 rounded-md border border-slate-700 bg-slate-800 px-2 py-1 whitespace-nowrap text-slate-200"
            >
              <span className="font-medium">{MODE_LABELS[session.mode]}</span>
              <span aria-hidden className="text-slate-500">·</span>
              <span>{SET_LABELS[session.caseSet]} set</span>
              <span aria-hidden className="text-slate-500">·</span>
              <span className="font-mono text-[11px] text-slate-400" title={session.sessionId}>
                {shortId(session.sessionId)}
              </span>
            </p>
            {session.mode === "expert" && (
              <nav aria-label="Expert views" className="flex items-center gap-1">
                <Button asChild size="sm" variant="ghost" className="text-slate-300 hover:bg-slate-800 hover:text-white">
                  <Link href={`/debrief/${encodeURIComponent(session.sessionId)}`}>
                    <ClipboardCheck data-icon="inline-start" />
                    Debrief
                  </Link>
                </Button>
                <Button asChild size="sm" variant="ghost" className="text-slate-300 hover:bg-slate-800 hover:text-white">
                  <Link href={`/workmap/${encodeURIComponent(session.sessionId)}`}>
                    <Map data-icon="inline-start" />
                    Work Map
                  </Link>
                </Button>
              </nav>
            )}
            <Button
              asChild
              size="sm"
              variant="ghost"
              className="text-slate-300 hover:bg-slate-800 hover:text-white"
            >
              <Link href="/sandbox">
                <Plus data-icon="inline-start" />
                New session
              </Link>
            </Button>
          </>
        )}
        <span aria-hidden className="h-4 w-px bg-slate-700" />
        <AccountChip viewer={viewer} />
      </div>
    </header>
  );
}
