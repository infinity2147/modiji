"use client";

/**
 * "Coverage under current model" (plan §7.5 #5): the four criteria, computed by code on the server.
 * The closing sentence appears only when all four hold — never as a claim about the expert's whole
 * knowledge, only about the current feature model.
 */
import { motion } from "framer-motion";
import { Check, X } from "lucide-react";
import type { Coverage } from "@vashistha/core";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";

export const CLOSED_SENTENCE = "No unresolved counterexample exists under the current feature model.";

/** A half-circle showing how many of the checks hold; amber while open, teal when all are met. */
function Gauge({ met, of }: { met: number; of: number }) {
  const done = met === of;
  return (
    <div className="relative mx-auto grid max-w-56 place-items-center" role="img" aria-label={`${met} of ${of} checks met`}>
      <svg viewBox="0 0 200 118" className="w-full" aria-hidden>
        <path d="M20 100 A80 80 0 0 1 180 100" pathLength="100" fill="none" stroke="var(--border)" strokeWidth="16" strokeLinecap="round" />
        <path
          d="M20 100 A80 80 0 0 1 180 100"
          pathLength="100"
          fill="none"
          stroke={done ? "var(--primary)" : "var(--highlight)"}
          strokeWidth="16"
          strokeLinecap="round"
          strokeDasharray={`${Math.max(0.1, (met / of) * 100)} 100`}
        />
      </svg>
      <div className="absolute bottom-0 grid justify-items-center leading-none">
        <span className="font-heading text-4xl font-bold">
          {met}
          <span className="text-lg text-muted-foreground"> / {of}</span>
        </span>
        <span className="mt-1 text-xs text-muted-foreground">checks met</span>
      </div>
    </div>
  );
}

export function CoveragePanel({ coverage, revision }: { coverage: Coverage; revision: number }) {
  const { decisionsExplained: d } = coverage;
  const criteria = [
    { label: "Observed decisions explained", value: `${d.explained}/${d.total}`, ok: d.total > 0 && d.explained === d.total },
    {
      label: "Unresolved witnesses",
      value: `${coverage.unresolvedWitnesses}${coverage.acknowledgedWitnesses > 0 ? ` (+${coverage.acknowledgedWitnesses} expert: escalate to controller)` : ""}`,
      ok: coverage.unresolvedWitnesses === 0,
    },
    { label: "Undefined concepts", value: String(coverage.undefinedConcepts), ok: coverage.undefinedConcepts === 0 },
    { label: "Teach-back confirmed", value: coverage.teachBackConfirmed ? "yes" : "no", ok: coverage.teachBackConfirmed },
  ];
  return (
    <Card aria-label="Coverage under current model" data-testid="coverage-panel" data-closed={coverage.closed}>
      <CardHeader>
        <CardTitle>Coverage under current model</CardTitle>
        <p className="text-xs text-muted-foreground">
          Feature model v{coverage.schemaVersion} · rulebook revision {revision} · computed by code
        </p>
      </CardHeader>
      <CardContent className="space-y-3">
        <Gauge met={criteria.filter((c) => c.ok).length} of={criteria.length} />
        <ul className="space-y-1.5">
          {criteria.map((c) => (
            <li key={c.label} className="flex items-center gap-2" data-ok={c.ok}>
              {c.ok ? <Check className="size-4 text-primary" aria-label="met" /> : <X className="size-4 text-destructive" aria-label="not met" />}
              <span className="flex-1">{c.label}</span>
              <span className="font-mono text-xs">{c.value}</span>
            </li>
          ))}
        </ul>
        {coverage.closed && (
          <motion.p
            initial={{ opacity: 0, y: 6 }}
            animate={{ opacity: 1, y: 0 }}
            className="rounded-md bg-secondary px-3 py-2 font-medium text-secondary-foreground"
            data-testid="coverage-closed"
          >
            {CLOSED_SENTENCE}
          </motion.p>
        )}
      </CardContent>
    </Card>
  );
}
