"use client";

import { useState } from "react";
import { Wrench } from "lucide-react";
import type { InterviewLoop } from "@/lib/client/voice/use-interview";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { ComplianceStrip } from "./compliance-strip";
import { EngineeringView } from "./engineering-view";
import { EventTicker } from "./event-ticker";
import { HudBar } from "./hud-bar";

/**
 * The judge view, in CaseDesk's full-width row under the three columns: gate HUD, event ticker and
 * compliance strip, with an Engineering view toggle for full telemetry. Marked `data-gate-ignore`:
 * its own updates are not the expert's screen moving.
 */
export function JudgeView({ sessionId, loop }: { sessionId: string; loop: InterviewLoop }) {
  const [engineering, setEngineering] = useState(false);
  return (
    <div data-gate-ignore="" className="flex min-h-0 flex-col border-t bg-card">
      <div className="flex items-center bg-slate-900 pr-2">
        <div className="min-w-0 flex-1">
          <HudBar gate={loop.gate} voiceLive={loop.voice.state === "connected"} />
        </div>
        <Button
          size="xs"
          variant="ghost"
          aria-pressed={engineering}
          aria-controls="engineering-view"
          onClick={() => setEngineering((open) => !open)}
          className={cn("text-slate-300 hover:bg-slate-800 hover:text-white", engineering && "bg-slate-700 text-white")}
        >
          <Wrench data-icon="inline-start" />
          Engineering view
        </Button>
      </div>
      <div className={cn("grid min-h-0 border-b", engineering ? "h-72 grid-cols-[minmax(0,2.4fr)_minmax(0,1fr)]" : "h-32 grid-cols-1")}>
        {engineering && (
          <div id="engineering-view" role="region" aria-label="Engineering view" className="min-h-0 overflow-y-auto border-r">
            <EngineeringView sessionId={sessionId} gate={loop.gate} />
          </div>
        )}
        <EventTicker ledger={loop.ledger} />
      </div>
      <ComplianceStrip entries={loop.ledger.entries} />
    </div>
  );
}
