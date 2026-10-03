"use client";

/**
 * Ledger trace of any element (plan §7.6 lineage view, §12 ledger-based debugging). `TraceButton`
 * opens the provenance chain of one ledger entry: Frame → ScreenEvent → Decision → Candidate →
 * (Witness) → Question → Answer → ConfirmedRule → TutorIntervention, animated stage by stage. Only
 * stages with real entries are drawn; derivations (checks, resolutions, exports) are listed below.
 */
import { createContext, useCallback, useContext, useMemo, useState, type ReactNode } from "react";
import { AnimatePresence, motion } from "framer-motion";
import { GitBranch } from "lucide-react";
import { describeError } from "@/lib/client/api";
import type { LineageNodeView, LineageResponse } from "@/lib/contracts/debrief";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { getLineage } from "@/components/debrief/api";

const STAGES: { id: string; label: string }[] = [
  { id: "frame", label: "Frame" },
  { id: "screen_event", label: "Screen event" },
  { id: "decision", label: "Decision" },
  { id: "candidate", label: "Candidate" },
  { id: "witness", label: "Witness" },
  { id: "question", label: "Question" },
  { id: "answer", label: "Answer" },
  { id: "confirmed_rule", label: "Confirmed rule" },
  { id: "tutor_intervention", label: "Tutor intervention" },
];

type TraceState = { label: string; entryId: string; data?: LineageResponse; error?: string };
type TraceApi = { trace: (entryId: string, label: string) => void };

const TraceContext = createContext<TraceApi | null>(null);

export function LineageProvider({ sessionId, children }: { sessionId: string; children: ReactNode }) {
  const [state, setState] = useState<TraceState | null>(null);
  const trace = useCallback(
    (entryId: string, label: string) => {
      setState({ entryId, label });
      getLineage(fetch, sessionId, entryId).then(
        (data) => setState((s) => (s?.entryId === entryId ? { ...s, data } : s)),
        (error: unknown) => setState((s) => (s?.entryId === entryId ? { ...s, error: describeError(error) } : s)),
      );
    },
    [sessionId],
  );
  const api = useMemo(() => ({ trace }), [trace]);
  return (
    <TraceContext.Provider value={api}>
      {children}
      <Dialog open={state !== null} onOpenChange={(open) => !open && setState(null)}>
        <DialogContent className="max-h-[85vh] overflow-y-auto sm:max-w-3xl" aria-label="Ledger trace">
          <DialogHeader>
            <DialogTitle>Ledger trace · {state?.label}</DialogTitle>
            <DialogDescription>
              Provenance from the append-only ledger. Solid links are recorded parents; dashed links are the step&apos;s screen moment.
            </DialogDescription>
          </DialogHeader>
          {state?.error !== undefined && <p className="text-destructive">{state.error}</p>}
          {state?.data === undefined && state?.error === undefined && <p className="text-muted-foreground">Loading trace…</p>}
          {state?.data !== undefined && <Chain data={state.data} />}
        </DialogContent>
      </Dialog>
    </TraceContext.Provider>
  );
}

/** Opens a trace programmatically (e.g. from an SVG node); null outside a `LineageProvider`. */
export function useTrace(): TraceApi | null {
  return useContext(TraceContext);
}

export function TraceButton({ entryId, label, className }: { entryId: string | null; label: string; className?: string }) {
  const api = useTrace();
  if (api === null || entryId === null) return null;
  return (
    <Button
      type="button"
      variant="ghost"
      size="xs"
      className={className}
      onClick={() => api.trace(entryId, label)}
      aria-label={`Trace ${label}`}
      title="Show the ledger trace"
    >
      <GitBranch />
      Trace
    </Button>
  );
}

function Chain({ data }: { data: LineageResponse }) {
  const stages = STAGES.map((s) => ({ ...s, nodes: data.nodes.filter((n) => n.stage === s.id) })).filter((s) => s.nodes.length > 0);
  const derivations = data.nodes.filter((n) => n.stage === "derivation");
  const inferred = new Set(data.edges.filter((e) => e.via === "screen_moment").map((e) => e.from));
  return (
    <div className="space-y-2" data-testid="lineage-chain">
      <AnimatePresence>
        {stages.map((stage, i) => (
          <motion.div
            key={stage.id}
            initial={{ opacity: 0, x: -16 }}
            animate={{ opacity: 1, x: 0 }}
            transition={{ delay: i * 0.18, duration: 0.25 }}
            className="relative pl-6"
            data-stage={stage.id}
          >
            {i > 0 && <span aria-hidden className="absolute top-[-0.6rem] left-[0.55rem] h-3 border-l-2 border-primary/40" />}
            <span aria-hidden className="absolute top-2 left-1 size-3 rounded-full bg-primary" />
            <p className="text-xs font-semibold tracking-wide text-muted-foreground uppercase">{stage.label}</p>
            <ul className="mt-1 space-y-1">
              {stage.nodes.map((n) => (
                <NodeRow key={n.id} node={n} dashed={inferred.has(n.id)} focus={n.id === data.focus} />
              ))}
            </ul>
          </motion.div>
        ))}
      </AnimatePresence>
      {derivations.length > 0 && (
        <details className="pt-2 text-xs text-muted-foreground">
          <summary>{derivations.length} other derivation(s)</summary>
          <ul className="mt-1 space-y-1">
            {derivations.map((n) => (
              <NodeRow key={n.id} node={n} dashed={false} focus={n.id === data.focus} />
            ))}
          </ul>
        </details>
      )}
    </div>
  );
}

function NodeRow({ node, dashed, focus }: { node: LineageNodeView; dashed: boolean; focus: boolean }) {
  return (
    <li
      className={`flex items-start gap-2 rounded-md border px-2 py-1.5 ${dashed ? "border-dashed" : ""} ${focus ? "border-primary bg-accent" : "bg-card"}`}
      data-kind={node.kind}
    >
      {node.mediaUrl !== null && (
        // Redacted frame from the perception store (best-effort blur; synthetic data).
        <img src={node.mediaUrl} alt="Redacted frame" className="h-12 w-20 rounded object-cover" />
      )}
      <div className="min-w-0 flex-1">
        <p className="text-sm break-words">{node.summary}</p>
        <p className="font-mono text-[0.7rem] text-muted-foreground">
          {node.kind} · {node.source} · #{node.sequence}
        </p>
      </div>
      {focus && <Badge variant="outline">traced</Badge>}
    </li>
  );
}
