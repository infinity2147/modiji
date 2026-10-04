"use client";

import Link from "next/link";
import { ShieldCheck, Radio } from "lucide-react";
import type { ReplayBundleResponse } from "@/lib/contracts/replay";
import { Button } from "@/components/ui/button";

const WHEN = new Intl.DateTimeFormat("en-GB", { dateStyle: "medium", timeStyle: "medium", timeZone: "UTC" });

export function hostOf(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
}

/**
 * The persistent, unmissable label of replay mode (plan §10): what is shown is a recording of a genuine
 * run, where it came from, when, and that the server re-verified its integrity on this load.
 */
export function ReplayBanner({ data }: { data: ReplayBundleResponse }) {
  const { manifest, verification } = data;
  const head = manifest.timeline.head;
  return (
    <header
      role="banner"
      aria-label="Verified replay"
      data-testid="replay-banner"
      className="flex shrink-0 flex-wrap items-center gap-x-4 gap-y-1 border-b-4 border-violet-500 bg-violet-950 px-4 py-2 text-violet-50"
    >
      <p className="flex min-w-0 flex-1 items-center gap-2 text-sm font-semibold">
        <span className="rounded bg-violet-500 px-1.5 py-0.5 font-mono text-xs tracking-widest text-white">REPLAY</span>
        <span data-testid="replay-banner-text">
          VERIFIED REPLAY — recorded run {manifest.bundleId} from {hostOf(manifest.source.baseUrl)} at {WHEN.format(manifest.timeline.firstAt)} UTC; integrity{" "}
          <span className="text-emerald-300">✓</span> ({verification.entries} entries, chain {head.slice(0, 12)})
        </span>
      </p>
      <p className="flex items-center gap-1.5 text-xs text-violet-200" title={`manifest sha256 ${data.manifestSha256} · chain head ${head}`}>
        <ShieldCheck aria-hidden className="size-3.5 text-emerald-300" />
        Re-verified on this load: {verification.files} files hashed, hash chain recomputed · server v{manifest.source.version}
        {manifest.source.commit === null ? "" : ` · ${manifest.source.commit.slice(0, 7)}`} · not live: nothing is written, no model or voice call
      </p>
      <Button asChild size="sm" className="bg-emerald-500 text-emerald-950 hover:bg-emerald-400">
        <Link href="/sandbox" data-testid="try-live">
          <Radio data-icon="inline-start" />
          Try live
        </Link>
      </Button>
    </header>
  );
}
