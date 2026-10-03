/**
 * Lineage trace (plan §7.6, §12): every Work Map element can show the ledger entries it derives from
 * and what was derived from it. Nodes are ledger entries; edges are the provenance `parentIds`, plus
 * optional screen-moment links that the Work Map infers from ledger order (frames and screen events
 * of a step, which carry no parent edge to the decision) — those are marked `screen_moment`.
 * `system_control` entries never appear (they are not evidence, plan §7.2).
 */
import type { LedgerEntry } from "../schemas/ledger";
import { isEvidenceEligible } from "../schemas/ledger";
import { byLedgerOrder } from "./build";

/** The trace stages in plan order: Frame → ScreenEvent → Decision → Candidate → (Witness) → Question → Answer → ConfirmedRule → TutorIntervention. */
export const LINEAGE_STAGES = [
  "frame",
  "screen_event",
  "decision",
  "candidate",
  "witness",
  "question",
  "answer",
  "confirmed_rule",
  "tutor_intervention",
] as const;
export type LineageStage = (typeof LINEAGE_STAGES)[number] | "derivation";

const STAGE_OF_KIND: Readonly<Record<string, LineageStage>> = {
  "frame.received": "frame",
  "screen.event": "screen_event",
  "case.decision": "decision",
  "hypotheses.updated": "candidate",
  "concept.proposed": "candidate",
  "witness.found": "witness",
  "question.queued": "question",
  "gate.authorized": "question",
  "agent.utterance": "question",
  "teachback.generated": "question",
  "utterance.transcript": "answer",
  "answer.parsed": "answer",
  "expert.statement": "answer",
  "rule.confirmed": "confirmed_rule",
  "rule.revised": "confirmed_rule",
  "rule.retired": "confirmed_rule",
  "tutor.intervention": "tutor_intervention",
};

/** The trace stage of a ledger kind; anything else (checks, resolutions, exports, …) is a `derivation`. */
export function lineageStage(kind: string): LineageStage {
  return STAGE_OF_KIND[kind] ?? "derivation";
}

export type LineageNode = {
  id: string;
  sessionId: string;
  sequence: number;
  kind: string;
  source: LedgerEntry["source"];
  stage: LineageStage;
  occurredAt: number;
  /** "ancestor" | "focus" | "descendant": where the node sits relative to the traced entry. */
  role: "ancestor" | "focus" | "descendant";
};
export type LineageEdge = { from: string; to: string; via: "parent" | "screen_moment" };
export type Lineage = { focus: string; nodes: LineageNode[]; edges: LineageEdge[] };

/**
 * The provenance DAG through `entryId`: all its ancestors and descendants (following `parentIds` and
 * the given screen-moment links, which point from a frame/event to the entry it informed). Nodes are
 * ordered by stage (derivations last), then ledger order; edges connect only listed nodes. Returns undefined when the
 * entry is not among `entries` or is a `system_control` entry.
 */
export function lineage(entries: readonly LedgerEntry[], entryId: string, links: readonly { from: string; to: string }[] = []): Lineage | undefined {
  const byId = new Map(entries.filter(isEvidenceEligible).map((e) => [e.id, e]));
  const focus = byId.get(entryId);
  if (focus === undefined) return undefined;

  const edges: LineageEdge[] = [];
  for (const e of byId.values()) for (const p of e.parentIds) if (byId.has(p)) edges.push({ from: p, to: e.id, via: "parent" });
  for (const l of links) if (byId.has(l.from) && byId.has(l.to)) edges.push({ from: l.from, to: l.to, via: "screen_moment" });

  const walk = (start: string, next: (id: string) => string[]): Set<string> => {
    const seen = new Set<string>();
    const stack = [start];
    for (let id = stack.pop(); id !== undefined; id = stack.pop())
      for (const n of next(id))
        if (!seen.has(n) && n !== start) {
          seen.add(n);
          stack.push(n);
        }
    return seen;
  };
  const up = walk(entryId, (id) => edges.filter((e) => e.to === id).map((e) => e.from));
  const down = walk(entryId, (id) => edges.filter((e) => e.from === id).map((e) => e.to));

  const stageIndex = (s: LineageStage): number => (s === "derivation" ? LINEAGE_STAGES.length : LINEAGE_STAGES.indexOf(s));
  const traced = [focus, ...[...up, ...down].flatMap((id) => byId.get(id) ?? [])];
  // Stage order first (derivations last), then ledger order.
  traced.sort((a, b) => stageIndex(lineageStage(a.kind)) - stageIndex(lineageStage(b.kind)) || byLedgerOrder(a, b));
  const nodes = traced.map(
    (e): LineageNode => ({
      id: e.id,
      sessionId: e.sessionId,
      sequence: e.sequence,
      kind: e.kind,
      source: e.source,
      stage: lineageStage(e.kind),
      occurredAt: e.occurredAt,
      role: e.id === entryId ? "focus" : up.has(e.id) ? "ancestor" : "descendant",
    }),
  );
  const included = new Set(nodes.map((n) => n.id));
  return { focus: entryId, nodes, edges: edges.filter((e) => included.has(e.from) && included.has(e.to)) };
}
