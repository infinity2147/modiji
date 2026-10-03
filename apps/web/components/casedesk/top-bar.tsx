import Link from "next/link";
import { Eye, Landmark, Plus } from "lucide-react";
import type { SessionRef } from "@/lib/client/session-url";
import { shortId } from "@/lib/client/format";
import { Button } from "@/components/ui/button";
import { MODE_LABELS, SET_LABELS } from "./labels";

/** Northstar Bank · CaseDesk header. Always states that the data is synthetic and how the app senses. */
export function TopBar({ session }: { session?: SessionRef | undefined }) {
  return (
    <header className="flex h-12 shrink-0 items-center gap-4 border-b border-slate-800 bg-slate-900 px-4 text-slate-100">
      <div className="flex items-center gap-2.5">
        <span aria-hidden className="grid size-7 place-items-center rounded-md bg-blue-600 text-white">
          <Landmark className="size-4" />
        </span>
        <span className="text-sm font-semibold tracking-tight">Northstar Bank</span>
        <span aria-hidden className="h-4 w-px bg-slate-700" />
        <h1 className="text-sm font-medium text-slate-300">CaseDesk</h1>
      </div>
      <span className="rounded border border-amber-400/40 bg-amber-400/10 px-1.5 py-0.5 text-[11px] font-medium text-amber-200">
        Synthetic data — fictional policy
      </span>

      <div className="ml-auto flex items-center gap-3 text-xs">
        <p className="flex items-center gap-1.5 text-slate-400">
          <Eye aria-hidden className="size-3.5" />
          Sensing: DOM events (this app) — disclosed
        </p>
        {session && (
          <>
            <span aria-hidden className="h-4 w-px bg-slate-700" />
            <p
              aria-label="Session"
              className="flex items-center gap-2 rounded-md border border-slate-700 bg-slate-800 px-2 py-1 text-slate-200"
            >
              <span className="font-medium">{MODE_LABELS[session.mode]}</span>
              <span aria-hidden className="text-slate-500">·</span>
              <span>{SET_LABELS[session.caseSet]} set</span>
              <span aria-hidden className="text-slate-500">·</span>
              <span className="font-mono text-[11px] text-slate-400" title={session.sessionId}>
                {shortId(session.sessionId)}
              </span>
            </p>
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
      </div>
    </header>
  );
}
