"use client";

import { useEffect, useMemo, useRef } from "react";
import { AnimatePresence, motion } from "framer-motion";
import type { LedgerSource } from "@vashistha/core";
import type { LedgerTailState } from "@/lib/client/judge/ledger-tail";
import { tickerLines, type TickerTone } from "@/lib/client/judge/ticker";
import { cn } from "@/lib/utils";

const VISIBLE_LINES = 60;

const SOURCE_STYLE: Record<LedgerSource, string> = {
  dom: "bg-sky-100 text-sky-800",
  vision: "bg-violet-100 text-violet-800",
  voice: "bg-emerald-100 text-emerald-800",
  engine: "bg-slate-200 text-slate-700",
  solver: "bg-amber-100 text-amber-800",
  expert: "bg-teal-100 text-teal-800",
  client: "bg-indigo-100 text-indigo-800",
  system_control: "bg-transparent text-slate-400 ring-1 ring-inset ring-slate-300",
};

const TONE_STYLE: Record<TickerTone, string> = {
  evidence: "text-foreground",
  system: "text-slate-600",
  control: "text-slate-400 italic",
  privacy: "text-red-700 italic",
  warning: "text-amber-800",
};

const TIME = new Intl.DateTimeFormat("en-GB", { hour: "2-digit", minute: "2-digit", second: "2-digit" });

/** Live ledger tail as human lines, each labelled with its source; control traffic is visibly not evidence. */
export function EventTicker({ ledger, caption = "live ledger" }: { ledger: LedgerTailState; caption?: string }) {
  const lines = useMemo(() => tickerLines(ledger.entries, VISIBLE_LINES), [ledger.entries]);
  const listRef = useRef<HTMLOListElement>(null);
  const last = lines.at(-1)?.id;

  useEffect(() => {
    const list = listRef.current;
    if (list && last !== undefined) list.scrollTop = list.scrollHeight;
  }, [last]);

  return (
    <section aria-labelledby="ticker-title" className="flex min-h-0 flex-col">
      <div className="flex items-baseline justify-between px-3 pt-2 pb-1">
        <h2 id="ticker-title" className="text-xs font-semibold">
          Event ticker <span className="font-normal text-muted-foreground">· {caption}</span>
        </h2>
        {ledger.error !== undefined && (
          <p role="status" className="text-[11px] text-destructive">
            Ledger unavailable: {ledger.error}
          </p>
        )}
      </div>
      <ol ref={listRef} role="log" aria-label="Ledger events" className="min-h-0 flex-1 overflow-y-auto px-3 pb-2 font-mono text-[11.5px]">
        {!ledger.caughtUp && lines.length === 0 && <li className="text-muted-foreground">Reading the ledger…</li>}
        <AnimatePresence initial={false}>
          {lines.map((line) => (
            <motion.li
              key={line.id}
              initial={{ opacity: 0, x: -6 }}
              animate={{ opacity: 1, x: 0 }}
              transition={{ duration: 0.18 }}
              data-source={line.source}
              data-tone={line.tone}
              className="flex items-baseline gap-2 py-px leading-snug"
            >
              <time className="shrink-0 text-muted-foreground tabular-nums" dateTime={new Date(line.occurredAt).toISOString()}>
                {TIME.format(line.occurredAt)}
              </time>
              <span
                className={cn(
                  "inline-flex w-[5.5rem] shrink-0 justify-center rounded px-1 text-[10px] leading-4 font-medium",
                  SOURCE_STYLE[line.source],
                )}
              >
                {line.source === "system_control" ? "control" : line.source}
              </span>
              <span className={cn("min-w-0 truncate", TONE_STYLE[line.tone])} title={line.text}>
                {line.text}
              </span>
            </motion.li>
          ))}
        </AnimatePresence>
      </ol>
    </section>
  );
}
