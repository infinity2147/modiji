"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { describeError, requestJson } from "@/lib/client/api";
import { ReplayListResponseSchema, type ReplayListResponse } from "@/lib/contracts/replay";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";

const WHEN = new Intl.DateTimeFormat("en-GB", { dateStyle: "medium", timeStyle: "short", timeZone: "UTC" });

/** `/replay`: the recorded runs on this server. Opening one re-verifies it. */
export function ReplayList() {
  const [list, setList] = useState<ReplayListResponse | null>(null);
  const [error, setError] = useState<string>();
  useEffect(() => {
    requestJson(fetch, "/api/replays", ReplayListResponseSchema).then(setList, (e: unknown) => setError(describeError(e)));
  }, []);
  return (
    <main className="mx-auto max-w-3xl space-y-4 px-4 py-8">
      <header>
        <h1 className="text-2xl font-semibold tracking-tight">Verified replay · recorded runs</h1>
        <p className="text-sm text-muted-foreground">
          Genuine runs exported from a live server (<code>pnpm replay:export</code>), integrity-checked on every load and replayed read-only through the same UI.{" "}
          <Link className="underline" href="/sandbox">
            Try live instead
          </Link>
          .
        </p>
      </header>
      {error !== undefined && <p className="text-destructive">{error}</p>}
      {list?.bundles.length === 0 && <p className="text-muted-foreground">No recorded runs on this server (DATA_DIR/replays is empty).</p>}
      {list?.bundles.map((b) => (
        <Card key={b.bundleId}>
          <CardHeader>
            <CardTitle>
              <Link className="font-mono underline" href={`/replay/${b.bundleId}`}>
                {b.bundleId}
              </Link>
            </CardTitle>
          </CardHeader>
          <CardContent className="text-sm text-muted-foreground">
            Recorded {WHEN.format(b.firstAt)} UTC from {b.sourceBaseUrl} · {b.entries} entries · {b.sessions.map((s) => s.mode).join(" + ")} · exported{" "}
            {WHEN.format(b.exportedAt)} UTC
          </CardContent>
        </Card>
      ))}
    </main>
  );
}
