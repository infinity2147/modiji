"use client";

import { AnimatePresence } from "framer-motion";
import type { DebriefState, ExpertActionRequest } from "@/lib/contracts/debrief";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { CoveragePanel } from "@/components/debrief/coverage-panel";
import { DecisionsCard, GapsCard, ProposalsCard, TeachBackPanel } from "@/components/debrief/debrief-view";
import { RulebookPanel } from "@/components/debrief/rulebook-panel";
import { WitnessCard } from "@/components/debrief/witness-card";

const readOnly = (_: ExpertActionRequest): Promise<void> => Promise.reject(new Error("Verified replay is read-only."));

/**
 * The debrief of a recorded expert session at the current replay position: the live debrief's own
 * panels (coverage, teach-back, decisions, gaps, Z3 witnesses, rulebook with its diff, proposals) over
 * the state the server derives from the recorded entries. Disabled: the expert's actions are history.
 */
export function ReplayDebrief({ state }: { state: DebriefState }) {
  return (
    <fieldset disabled aria-label="Recorded debrief (read-only)" className="min-w-0">
      <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_minmax(0,1.6fr)]">
        <div className="space-y-4">
          <CoveragePanel coverage={state.coverage} revision={state.rulebookRevision} />
          <TeachBackPanel state={state} busy generate={() => undefined} act={readOnly} />
          <DecisionsCard state={state} />
          <GapsCard state={state} />
        </div>
        <div className="space-y-4">
          <Card aria-label="Solver witnesses">
            <CardHeader>
              <CardTitle>
                Counterexamples (Z3) · debrief questions {state.debriefQuestions} · gaps closed {state.gapsClosed.closed}/{state.gapsClosed.total}
              </CardTitle>
            </CardHeader>
            <CardContent>
              <ul className="space-y-2">
                <AnimatePresence>
                  {[...state.witnesses]
                    .sort((a, b) => Number(b.current) - Number(a.current))
                    .map((v) => (
                      <WitnessCard key={v.witness.id} view={v} state={state} act={readOnly} />
                    ))}
                </AnimatePresence>
              </ul>
              {state.witnesses.length === 0 && <p className="text-muted-foreground">No witnesses at this point of the recording.</p>}
            </CardContent>
          </Card>
          <RulebookPanel state={state} act={readOnly} />
          <ProposalsCard state={state} act={readOnly} />
        </div>
      </div>
    </fieldset>
  );
}
