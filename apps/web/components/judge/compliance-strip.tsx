"use client";

import { useMemo } from "react";
import { motion } from "framer-motion";
import { CheckCircle2, CircleDashed } from "lucide-react";
import type { LedgerEntry } from "@vashistha/core";
import { computeCompliance, DEBRIEF_GAP_TARGET, LIVE_QUESTION_TARGET } from "@/lib/client/judge/compliance";
import { cn } from "@/lib/utils";

type Item = { label: string; earned: boolean; value: string; detail: string };

function StripItem({ item }: { item: Item }) {
  return (
    <li
      aria-label={`${item.label}: ${item.value}${item.earned ? ", earned" : ", pending"}`}
      title={item.detail}
      className={cn(
        "flex items-center gap-1.5 rounded-md px-2 py-1 text-xs whitespace-nowrap transition-colors duration-500",
        item.earned ? "bg-emerald-50 text-emerald-800 ring-1 ring-emerald-200 ring-inset" : "text-muted-foreground",
      )}
    >
      {item.earned ? (
        <motion.span initial={{ scale: 0.6 }} animate={{ scale: 1 }} transition={{ type: "spring", stiffness: 400, damping: 18 }}>
          <CheckCircle2 aria-hidden className="size-3.5" />
        </motion.span>
      ) : (
        <CircleDashed aria-hidden className="size-3.5" />
      )}
      <span>{item.label}</span>
      <span className="font-mono font-semibold tabular-nums">{item.value}</span>
    </li>
  );
}

/** The persistent compliance strip (plan §10), computed from the session ledger only. */
export function ComplianceStrip({ entries }: { entries: readonly LedgerEntry[] }) {
  const c = useMemo(() => computeCompliance(entries), [entries]);
  const check = (earned: boolean) => (earned ? "✓" : "✗");
  const items: Item[] = [
    {
      label: "Live questions",
      earned: c.liveQuestions >= LIVE_QUESTION_TARGET,
      value: `${c.liveQuestions}/${LIVE_QUESTION_TARGET}`,
      detail: "Live questions the gate authorized and the agent spoke",
    },
    { label: "Guardrail", earned: c.guardrail, value: check(c.guardrail), detail: "A guardrail rule confirmed by the expert" },
    {
      label: "Debrief gaps closed",
      earned: c.debriefGaps >= DEBRIEF_GAP_TARGET,
      value: `${c.debriefGaps}/${DEBRIEF_GAP_TARGET}`,
      detail: "Solver counterexamples resolved by the expert in the debrief",
    },
    { label: "Teach-back", earned: c.teachBack, value: check(c.teachBack), detail: "The expert confirmed the teach-back" },
    {
      label: "Unseen case intercepted",
      earned: c.unseenCaseIntercepted,
      value: check(c.unseenCaseIntercepted),
      detail: "The tutor intervened and the violating action was not committed",
    },
  ];
  return (
    <section aria-labelledby="compliance-title" className="flex flex-wrap items-center gap-x-2 gap-y-1 px-3 py-1.5">
      <h2 id="compliance-title" className="mr-1 text-xs font-semibold">
        Compliance <span className="font-normal text-muted-foreground">· computed from the ledger</span>
      </h2>
      <ul aria-label="Compliance" className="flex flex-wrap items-center gap-1">
        {items.map((item) => (
          <StripItem key={item.label} item={item} />
        ))}
      </ul>
    </section>
  );
}
