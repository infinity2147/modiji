/**
 * Ledger trace of any debrief / Work Map element (plan §12): the provenance DAG through one ledger
 * entry of the session, with a one-line summary per node read from its payload. Steps add their
 * screen moment (frames and screen events → decision) as inferred `screen_moment` edges. Entries
 * outside the session are reachable only through parent edges of the session's own entries.
 */
import "server-only";
import {
  RuleConfirmedPayloadSchema,
  RuleRetiredPayloadSchema,
  RuleRevisedPayloadSchema,
  isLedgerKind,
  lineage,
  parseLedgerPayload,
  type LedgerEntry,
} from "@vashistha/core";
import type { LineageResponse } from "../../contracts/debrief";
import { ApiFailure } from "../casedesk/http";
import type { DebriefDeps } from "./deps";
import { DOMAIN, snapshot } from "./state";
import { ruleText } from "./text";
import { frameMediaUrl, screenEventSummary } from "./workmap";

const MAX_SUMMARY = 160;

function clip(text: string): string {
  return text.length <= MAX_SUMMARY ? text : `${text.slice(0, MAX_SUMMARY - 1)}…`;
}

function actionLabel(id: string): string {
  return DOMAIN.actions.find((a) => a.id === id)?.label ?? id;
}

/** One line describing an entry, from its validated payload. */
export function entrySummary(e: LedgerEntry): string {
  if (!isLedgerKind(e.kind)) return e.kind;
  switch (e.kind) {
    case "session.started": {
      const p = parseLedgerPayload(e, "session.started");
      return `Session started (${p.mode}, ${p.caseSet} cases)`;
    }
    case "frame.received": {
      const p = parseLedgerPayload(e, "frame.received");
      return `Redacted frame ${p.frameSeq} (${p.width}×${p.height}, ${p.redactedRegions} region(s) blurred)`;
    }
    case "screen.event":
      return `Screen (${e.source}): ${screenEventSummary(e)}`;
    case "interlock.check":
      return `Save interlock: ${parseLedgerPayload(e, "interlock.check").result.decision}`;
    case "case.decision": {
      const p = parseLedgerPayload(e, "case.decision");
      return `${p.caseId} → ${actionLabel(p.action)}`;
    }
    case "hypotheses.updated": {
      const p = parseLedgerPayload(e, "hypotheses.updated");
      return `Hypotheses (${p.decisionFamily})${p.top[0] === undefined ? "" : `: ${p.top[0].description}`}`;
    }
    case "witness.found": {
      const w = parseLedgerPayload(e, "witness.found");
      return `Solver witness: ${w.kind} (${w.decisionFamily})`;
    }
    case "witness.resolved":
      return `Witness resolved: ${parseLedgerPayload(e, "witness.resolved").resolution.replaceAll("_", " ")}`;
    case "question.queued": {
      const q = parseLedgerPayload(e, "question.queued");
      return `Question (${q.kind.replaceAll("_", " ")}): ${q.text}`;
    }
    case "gate.authorized":
      return "Gate authorised the question";
    case "agent.utterance":
      return `Agent: “${parseLedgerPayload(e, "agent.utterance").text}”`;
    case "utterance.transcript":
      return `Expert (voice): “${parseLedgerPayload(e, "utterance.transcript").text}”`;
    case "answer.parsed":
      return `Answer parsed (confidence ${parseLedgerPayload(e, "answer.parsed").confidence.toFixed(2)})`;
    case "expert.statement": {
      const p = parseLedgerPayload(e, "expert.statement");
      return `Expert (${p.utteranceId === undefined ? "typed" : "spoken"}): “${p.text}”`;
    }
    case "rule.confirmed": {
      const { rule } = RuleConfirmedPayloadSchema.parse(parseLedgerPayload(e, "rule.confirmed"));
      const t = ruleText(DOMAIN, rule);
      return `Confirmed rule: when ${t.when}, ${t.then}`;
    }
    case "rule.revised": {
      const { rule } = RuleRevisedPayloadSchema.parse(parseLedgerPayload(e, "rule.revised"));
      const t = ruleText(DOMAIN, rule);
      return `Revised rule (r${rule.revision}): when ${t.when}, ${t.then}`;
    }
    case "debrief.asked":
      return `Debrief asked: “${parseLedgerPayload(e, "debrief.asked").text}”`;
    case "debrief.replied": {
      const p = parseLedgerPayload(e, "debrief.replied");
      return `Expert (${p.via === "voice" ? "voice" : "typed"}, debrief): “${p.text}”`;
    }
    case "debrief.understood":
      return `Debrief reply read as ${parseLedgerPayload(e, "debrief.understood").intent}`;
    case "rule.retired": {
      const { ruleId, reason } = RuleRetiredPayloadSchema.parse(parseLedgerPayload(e, "rule.retired"));
      return `Deleted rule ${ruleId} (${reason})`;
    }
    case "teachback.generated":
      return `Teach-back (${parseLedgerPayload(e, "teachback.generated").origin === "llm" ? "Opus prose" : "template"})`;
    case "teachback.confirmed":
      return "Teach-back confirmed by the expert";
    case "workmap.generated":
      return "Work Map generated";
    case "tutor.intervention":
      return `Tutor intervention (${parseLedgerPayload(e, "tutor.intervention").trigger.replaceAll("_", " ")})`;
    default:
      return e.kind;
  }
}

export async function lineageView(deps: DebriefDeps, sessionId: string, entryId: string): Promise<LineageResponse> {
  const snap = await snapshot(deps, sessionId);
  if (!snap.entries.some((e) => e.id === entryId)) throw new ApiFailure(404, "entry_not_found", "no such entry in this session");
  const extra = [...deps.ledger.ancestors(entryId), ...deps.ledger.descendants(entryId)].filter((e) => e.source !== "system_control");
  const known = new Set(snap.entries.map((e) => e.id));
  const entries = [...snap.entries, ...extra.filter((e) => !known.has(e.id))];
  const links = snap.decisions.flatMap((d) => [...d.frameIds, ...d.eventIds].map((from) => ({ from, to: d.entry.id })));
  const traced = lineage(entries, entryId, links);
  if (traced === undefined) throw new ApiFailure(404, "entry_not_found", "no such entry in this session");
  const byId = new Map(entries.map((e) => [e.id, e]));
  return {
    focus: traced.focus,
    edges: traced.edges,
    nodes: traced.nodes.flatMap((n) => {
      const e = byId.get(n.id);
      if (e === undefined) return [];
      return [{ ...n, summary: clip(entrySummary(e)), mediaUrl: e.kind === "frame.received" ? frameMediaUrl(e) : null }];
    }),
  };
}
