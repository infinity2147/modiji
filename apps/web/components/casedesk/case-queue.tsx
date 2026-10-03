"use client";

import { motion } from "framer-motion";
import { NORTHSTAR_COUNTRY_RISK, type KycCase } from "@vashistha/core/domains/kyc";
import { actionLabel } from "@/lib/client/domain";
import type { DecisionRecord } from "@/lib/client/session-state";
import { cn } from "@/lib/utils";
import { ENTITY_LABELS } from "./labels";
import { Pill, RiskPill } from "./pills";

function DecisionStatus({ decision, animate }: { decision: DecisionRecord | undefined; animate: boolean }) {
  if (!decision) return <Pill tone="info">Open</Pill>;
  const pill = (
    <Pill tone={decision.override?.kind === "escalated" ? "warning" : "success"}>
      {decision.override?.kind === "escalated" ? "Decided · escalated" : "Decided"}
    </Pill>
  );
  if (!animate) return pill;
  return (
    <motion.span initial={{ opacity: 0, scale: 0.85 }} animate={{ opacity: 1, scale: 1 }} transition={{ duration: 0.25 }}>
      {pill}
    </motion.span>
  );
}

export function CaseQueue({
  cases,
  decisions,
  selectedId,
  lastCommitted,
  onOpen,
}: {
  cases: readonly KycCase[];
  decisions: ReadonlyMap<string, DecisionRecord>;
  selectedId: string | undefined;
  lastCommitted: string | undefined;
  onOpen: (caseId: string) => void;
}) {
  const decided = cases.filter((c) => decisions.has(c.id)).length;
  const progress = cases.length === 0 ? 0 : (decided / cases.length) * 100;

  return (
    <section aria-labelledby="queue-heading" className="flex min-h-0 flex-1 flex-col border-r bg-card">
      <div className="border-b px-4 pt-3 pb-2.5">
        <div className="flex items-baseline justify-between">
          <h2 id="queue-heading" className="text-sm font-semibold">
            Case queue
          </h2>
          <p className="text-xs text-muted-foreground tabular-nums">
            {decided} of {cases.length} decided
          </p>
        </div>
        <div
          role="progressbar"
          aria-label="Cases decided"
          aria-valuemin={0}
          aria-valuemax={cases.length}
          aria-valuenow={decided}
          className="mt-2 h-1 overflow-hidden rounded-full bg-muted"
        >
          <motion.div
            className="h-full rounded-full bg-primary"
            initial={false}
            animate={{ width: `${progress}%` }}
            transition={{ duration: 0.35, ease: "easeOut" }}
          />
        </div>
      </div>
      <ul aria-label="Cases" className="min-h-0 flex-1 divide-y overflow-y-auto">
        {cases.map((kycCase) => {
          const decision = decisions.get(kycCase.id);
          const selected = kycCase.id === selectedId;
          return (
            <li key={kycCase.id}>
              <button
                type="button"
                aria-current={selected ? "true" : undefined}
                onClick={() => onOpen(kycCase.id)}
                className={cn(
                  "relative grid w-full gap-1 px-4 py-3 text-left transition-colors outline-none hover:bg-muted/60 focus-visible:bg-muted/60 focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset",
                  selected && "bg-accent hover:bg-accent",
                )}
              >
                {selected && <span aria-hidden className="absolute inset-y-0 left-0 w-0.5 bg-primary" />}
                <span className="flex items-center justify-between gap-2">
                  <span className="font-mono text-xs text-muted-foreground">{kycCase.id}</span>
                  <DecisionStatus decision={decision} animate={lastCommitted === kycCase.id} />
                </span>
                <span className="truncate text-sm font-medium">{kycCase.customer.name}</span>
                <span className="flex items-center gap-2 text-xs text-muted-foreground">
                  <span>{ENTITY_LABELS[kycCase.customer.entityType]}</span>
                  <span aria-hidden>·</span>
                  <span className="truncate">{kycCase.customer.country}</span>
                  <RiskPill tier={NORTHSTAR_COUNTRY_RISK[kycCase.customer.country]} className="ml-auto" />
                </span>
                {decision && (
                  <span className="text-xs text-foreground/80">
                    Outcome: <span className="font-medium">{actionLabel(decision.action)}</span>
                  </span>
                )}
              </button>
            </li>
          );
        })}
      </ul>
    </section>
  );
}
