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
      <CardContent className="space-y-2">
        <ul className="space-y-1.5">
          {criteria.map((c) => (
            <li key={c.label} className="flex items-center gap-2" data-ok={c.ok}>
              {c.ok ? <Check className="size-4 text-emerald-600" aria-label="met" /> : <X className="size-4 text-destructive" aria-label="not met" />}
              <span className="flex-1">{c.label}</span>
              <span className="font-mono text-xs">{c.value}</span>
            </li>
          ))}
        </ul>
        {coverage.closed && (
          <motion.p
            initial={{ opacity: 0, y: 6 }}
            animate={{ opacity: 1, y: 0 }}
            className="rounded-md bg-emerald-50 px-3 py-2 font-medium text-emerald-900"
            data-testid="coverage-closed"
          >
            {CLOSED_SENTENCE}
          </motion.p>
        )}
      </CardContent>
    </Card>
  );
}
