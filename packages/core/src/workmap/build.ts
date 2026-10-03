/**
 * The canonical Work Map (plan §7.6), built by code from the ledger and the confirmed rulebook. One
 * step per committed expert decision; each step's screen moment, explaining rules, guardrails and the
 * expert's own words are derived deterministically. LLMs only supply `titles` and `summary`, which
 * the schema marks non-authoritative. Rejected or unconfirmed candidates never appear: the only rules
 * read are the confirmed ones passed in.
 */
import type { DomainConfig } from "../schemas/domain";
import type { LedgerEntry } from "../schemas/ledger";
import { parseLedgerPayload } from "../schemas/ledger-kinds";
import type { ActionId, FeatureValue, Value } from "../schemas/primitives";
import type { ConfirmedRule, ExpertQuoteEvidence } from "../schemas/rules";
import type { z } from "zod";
import { WorkMapSchema, type Coverage, type WorkMap, type WorkMapStepSchema } from "../schemas/workmap";
import { canonicalJson, contentId } from "../engine/canonical";
import { recordLookup } from "../engine/model";
import { explainDecision, familyOfAction, supportingQuotes, type DecisionExplanation, type ExplainableRule } from "./semantics";

/** Features of a case as the expert saw it when deciding (the case plus the reviewer's own edits); undefined when unknown. */
export type CaseFeatures = (caseId: string, edits: Readonly<Record<string, Value>>) => Readonly<Record<string, FeatureValue>> | undefined;

/** A committed decision of an expert session with its screen moment (ledger entry ids). */
export type ObservedDecision = {
  entry: LedgerEntry;
  caseId: string;
  action: ActionId;
  decisionFamily: string;
  features: Readonly<Record<string, FeatureValue>>;
  /** `frame.received` entries between the case being opened and the decision. */
  frameIds: string[];
  /** `screen.event` entries of the same window. */
  eventIds: string[];
};

/** Ledger order across sessions: received time, then session id, then sequence (as the ledger lists lineage). */
export function byLedgerOrder(a: LedgerEntry, b: LedgerEntry): number {
  return a.receivedAt - b.receivedAt || (a.sessionId < b.sessionId ? -1 : a.sessionId > b.sessionId ? 1 : 0) || a.sequence - b.sequence;
}

function expertSessions(entries: readonly LedgerEntry[]): Set<string> {
  const ids = new Set<string>();
  for (const e of entries)
    if (e.kind === "session.started" && e.source === "engine" && parseLedgerPayload(e, "session.started").mode === "expert") ids.add(e.sessionId);
  return ids;
}

/**
 * Committed decisions of expert sessions (sessions whose `session.started` says `expert`), in ledger
 * order. A decision's screen moment is the window from the latest `open_case` of its case before it
 * (else the previous decision of the session) up to the decision itself. Decisions whose case
 * features are unknown or whose action belongs to no decision family are not observations and are
 * skipped.
 */
export function observedDecisions(input: { domain: DomainConfig; entries: readonly LedgerEntry[]; caseFeatures: CaseFeatures }): ObservedDecision[] {
  const { domain, caseFeatures } = input;
  const entries = [...input.entries].sort(byLedgerOrder);
  const experts = expertSessions(entries);
  const out: ObservedDecision[] = [];
  const bySession = new Map<string, LedgerEntry[]>();
  for (const e of entries) if (experts.has(e.sessionId)) bySession.set(e.sessionId, [...(bySession.get(e.sessionId) ?? []), e]);

  for (const e of entries) {
    if (e.kind !== "case.decision" || e.source !== "dom" || !experts.has(e.sessionId)) continue;
    const { caseId, action, edits } = parseLedgerPayload(e, "case.decision");
    const family = familyOfAction(domain, action);
    const features = caseFeatures(caseId, edits);
    if (family === undefined || features === undefined) continue;
    const session = (bySession.get(e.sessionId) ?? []).filter((x) => x.sequence < e.sequence);
    const opened = session.findLast((x) => x.kind === "screen.event" && isOpenCase(x, caseId));
    const previous = session.findLast((x) => x.kind === "case.decision");
    const start = opened?.sequence ?? (previous === undefined ? -1 : previous.sequence + 1);
    const window = session.filter((x) => x.sequence >= start);
    out.push({
      entry: e,
      caseId,
      action,
      decisionFamily: family.id,
      features,
      frameIds: window.filter((x) => x.kind === "frame.received" && x.source === "client").map((x) => x.id),
      eventIds: window.filter((x) => x.kind === "screen.event").map((x) => x.id),
    });
  }
  return out;
}

function isOpenCase(e: LedgerEntry, caseId: string): boolean {
  const p = parseLedgerPayload(e, "screen.event");
  return p.kind === "open_case" && p.caseId === caseId;
}

/** Explanation of one observed decision under the rulebook (see semantics.ts). */
export function explainObserved(domain: DomainConfig, rules: readonly ExplainableRule[], d: ObservedDecision): DecisionExplanation {
  const family = domain.decisionFamilies.find((f) => f.id === d.decisionFamily);
  if (family === undefined) throw new RangeError(`unknown decision family ${d.decisionFamily}`);
  return explainDecision({ rules, family, action: d.action, lookup: recordLookup(d.features) });
}

/** Rules in a stable order: domain family order, then priority (highest first), then id. */
export function orderRules(domain: DomainConfig, rules: readonly ConfirmedRule[]): ConfirmedRule[] {
  const index = new Map(domain.decisionFamilies.map((f, i) => [f.id, i]));
  const family = (r: ConfirmedRule): number => index.get(r.decisionFamily) ?? Number.MAX_SAFE_INTEGER;
  return [...rules].sort((a, b) => family(a) - family(b) || b.priority - a.priority || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
}

export function stepId(decisionEntryId: string): string {
  return contentId("step", decisionEntryId);
}

/** "NS-2026-0101 — Send to enhanced review": the title used when no model wrote one. */
export function defaultStepTitle(domain: DomainConfig, caseId: string, action: string): string {
  return `${caseId} — ${domain.actions.find((a) => a.id === action)?.label ?? action}`;
}

export type BuildWorkMapInput = {
  id: string;
  domain: DomainConfig;
  /** Ledger entries of one or more sessions; only expert sessions contribute steps. */
  entries: readonly LedgerEntry[];
  rules: readonly ConfirmedRule[];
  revision: number;
  coverage: Coverage;
  caseFeatures: CaseFeatures;
  expertId: string;
  schemaVersion: number;
  /** LLM-written step titles by step id (non-authoritative); missing ones get `defaultStepTitle`. */
  titles?: Readonly<Record<string, string>>;
  /** LLM-written summary (non-authoritative). */
  summary?: string;
  now: number;
};

function quoteKey(q: ExpertQuoteEvidence): string {
  return canonicalJson([q.utteranceId, q.exactQuote, q.t0Ms, q.t1Ms]);
}

/** Builds and validates the Work Map. Pure and deterministic: equal inputs give equal Work Maps. */
export function buildWorkMap(input: BuildWorkMapInput): WorkMap {
  const { domain, rules } = input;
  const decisions = observedDecisions({ domain, entries: input.entries, caseFeatures: input.caseFeatures });
  const byId = new Map(rules.map((r) => [r.id, r]));
  const steps = decisions.map((d, order): z.input<typeof WorkMapStepSchema> => {
    const explanation = explainObserved(domain, rules, d);
    const id = stepId(d.entry.id);
    const seen = new Set<string>();
    const reasonQuotes = explanation.ruleIds
      .flatMap((rid) => {
        const rule = byId.get(rid);
        return rule === undefined ? [] : supportingQuotes(rule);
      })
      .filter((q) => {
        const key = quoteKey(q);
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
      });
    return {
      id,
      order,
      caseId: d.caseId,
      title: input.titles?.[id] ?? defaultStepTitle(domain, d.caseId, d.action),
      decision: { decisionFamily: d.decisionFamily, action: d.action, ledgerEntryId: d.entry.id },
      frameIds: d.frameIds,
      eventIds: d.eventIds,
      ruleIds: explanation.ruleIds,
      reasonQuotes,
      guardrailIds: explanation.guardrailIds,
    };
  });
  const raw: z.input<typeof WorkMapSchema> = {
    format: "vashistha.workmap/1",
    id: input.id,
    domainId: domain.id,
    expertId: input.expertId,
    sessionIds: [...new Set(input.entries.map((e) => e.sessionId))].sort(),
    generatedAt: input.now,
    schemaVersion: input.schemaVersion,
    rulebookRevision: input.revision,
    steps,
    rules: orderRules(domain, rules),
    coverage: input.coverage,
    summary: input.summary ?? "",
  };
  return WorkMapSchema.parse(raw);
}
