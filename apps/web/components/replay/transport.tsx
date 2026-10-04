"use client";

import { Pause, Play, SkipBack, SkipForward } from "lucide-react";
import type { LedgerEntry } from "@vashistha/core";
import { SPEEDS } from "@/lib/client/replay/clock";
import { Button } from "@/components/ui/button";
import type { Clock } from "./use-replay";

const TIME = new Intl.DateTimeFormat("en-GB", { hour: "2-digit", minute: "2-digit", second: "2-digit", timeZone: "UTC" });

function elapsed(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}

/** Play / pause / seek / speed over the recorded timeline. Seeking is by entry: every position is a real ledger state. */
export function Transport({ clock, entries, firstAt }: { clock: Clock; entries: readonly LedgerEntry[]; firstAt: number }) {
  const total = entries.length;
  const current = clock.n > 0 ? entries[clock.n - 1] : undefined;
  return (
    <div role="toolbar" aria-label="Replay controls" className="flex shrink-0 flex-wrap items-center gap-3 border-b bg-card px-4 py-2 text-xs">
      <Button size="icon-sm" variant="outline" aria-label="Back to the start" onClick={() => clock.seek(0)}>
        <SkipBack />
      </Button>
      {clock.playback.playing ? (
        <Button size="sm" onClick={clock.pause} aria-label="Pause">
          <Pause data-icon="inline-start" /> Pause
        </Button>
      ) : (
        <Button size="sm" onClick={clock.play} aria-label="Play">
          <Play data-icon="inline-start" /> Play
        </Button>
      )}
      <Button size="icon-sm" variant="outline" aria-label="To the end" onClick={() => clock.seek(total)}>
        <SkipForward />
      </Button>
      <input
        type="range"
        aria-label="Seek (recorded entries)"
        min={0}
        max={total}
        step={1}
        value={clock.n}
        onChange={(e) => clock.seek(Number(e.currentTarget.value))}
        className="min-w-48 flex-1 accent-violet-600"
      />
      <span className="font-mono tabular-nums" data-testid="replay-position" data-n={clock.n} data-total={total}>
        entry {clock.n}/{total}
      </span>
      <span className="font-mono text-muted-foreground tabular-nums" title="Recorded server time of the current entry (UTC) and time into the run">
        {current === undefined ? "before the first entry" : `${TIME.format(current.receivedAt)} UTC · +${elapsed(current.receivedAt - firstAt)}`}
      </span>
      <label className="flex items-center gap-1">
        Speed
        <select
          aria-label="Speed"
          value={clock.playback.speed}
          onChange={(e) => clock.setSpeed(Number(e.currentTarget.value))}
          className="rounded border bg-background px-1 py-0.5"
        >
          {SPEEDS.map((s) => (
            <option key={s} value={s}>
              {s}×
            </option>
          ))}
        </select>
      </label>
      <label className="flex items-center gap-1" title="Gaps longer than 2.5 s between recorded entries are shortened; order and content are unchanged">
        <input type="checkbox" checked={clock.skipIdle} onChange={(e) => clock.setSkipIdle(e.currentTarget.checked)} />
        Shorten idle gaps{clock.skipIdle && clock.timeline.shortened > 0 ? ` (${clock.timeline.shortened})` : ""}
      </label>
      {current !== undefined && (
        <span className="max-w-72 truncate font-mono text-muted-foreground" data-testid="replay-current-kind">
          {current.kind}
        </span>
      )}
    </div>
  );
}
