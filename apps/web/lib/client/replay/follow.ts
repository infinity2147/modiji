/** Which view shows the moment a replayed entry records (pure): the debrief, the Work Map, or that session's CaseDesk. */
import type { LedgerEntry } from "@vashistha/core";

export type ReplayTab = "casedesk" | "debrief" | "workmap";

const DEBRIEF_KINDS = new Set([
  "witness.found",
  "witness.resolved",
  "expert.statement",
  "teachback.generated",
  "teachback.confirmed",
  "rule.confirmed",
  "rule.revised",
  "rule.retired",
  "concept.confirmed",
  "concept.dismissed",
  "schema.version_bumped",
  "feature.backfilled",
]);

export function focusOf(entry: LedgerEntry, modeOf: (sessionId: string) => "expert" | "novice" | undefined): { sessionId: string; tab: ReplayTab } {
  const expert = modeOf(entry.sessionId) === "expert";
  if (expert && entry.kind === "workmap.generated") return { sessionId: entry.sessionId, tab: "workmap" };
  if (expert && DEBRIEF_KINDS.has(entry.kind)) return { sessionId: entry.sessionId, tab: "debrief" };
  return { sessionId: entry.sessionId, tab: "casedesk" };
}
