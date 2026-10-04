"use client";

import { useRef } from "react";
import { Volume2 } from "lucide-react";
import type { LedgerEntry } from "@vashistha/core";
import type { ReplayManifest } from "@/lib/replay/format";
import { Button } from "@/components/ui/button";

type Utterance = { conversationId: string; t0Ms: number };

/** The latest recorded utterance of `conversationId` in the prefix, with its offset into the conversation audio. */
function latestUtterance(prefix: readonly LedgerEntry[], conversationId: string): Utterance | undefined {
  for (let i = prefix.length - 1; i >= 0; i -= 1) {
    const e = prefix[i];
    if (e?.kind !== "utterance.transcript") continue;
    const p = e.payload as { conversationId?: unknown; t0Ms?: unknown };
    if (p.conversationId === conversationId && typeof p.t0Ms === "number") return { conversationId, t0Ms: p.t0Ms };
  }
  return undefined;
}

/**
 * Recorded conversation audio, only when the bundle has it (exported with --audio from the voice
 * provider; never synthesised). It plays from the bundle's own media route, from the latest recorded
 * expert utterance at the current replay position. Without audio the bundle's `missing` list says why.
 */
export function RecordedAudio({ manifest, prefix }: { manifest: ReplayManifest; prefix: readonly LedgerEntry[] }) {
  const clips = Object.keys(manifest.files).filter((p) => p.startsWith("audio/"));
  if (clips.length === 0) {
    const why = manifest.missing.find((m) => m.ref.startsWith("audio/"))?.reason;
    return why === undefined ? null : (
      <span className="text-xs text-muted-foreground" title={manifest.missing.map((m) => `${m.ref}: ${m.reason}`).join("\n")}>
        No recorded audio in this bundle ({why})
      </span>
    );
  }
  return (
    <div className="flex items-center gap-2 text-xs">
      {clips.map((path) => (
        <Clip key={path} bundleId={manifest.bundleId} conversationId={path.slice("audio/".length, -".mp3".length)} prefix={prefix} />
      ))}
    </div>
  );
}

function Clip({ bundleId, conversationId, prefix }: { bundleId: string; conversationId: string; prefix: readonly LedgerEntry[] }) {
  const audioRef = useRef<HTMLAudioElement>(null);
  const at = latestUtterance(prefix, conversationId);
  return (
    <span className="flex items-center gap-1">
      <audio ref={audioRef} preload="none" src={`/api/replays/${encodeURIComponent(bundleId)}/audio/${encodeURIComponent(conversationId)}.mp3`} />
      <Button
        size="xs"
        variant="outline"
        disabled={at === undefined}
        onClick={() => {
          const audio = audioRef.current;
          if (audio === null || at === undefined) return;
          audio.currentTime = at.t0Ms / 1000;
          void audio.play();
        }}
        title={at === undefined ? "No recorded utterance yet at this point" : `Recorded audio from ${(at.t0Ms / 1000).toFixed(1)} s into the conversation`}
      >
        <Volume2 data-icon="inline-start" />
        Recorded audio
      </Button>
    </span>
  );
}
