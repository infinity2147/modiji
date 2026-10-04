/**
 * P4 acceptance checks over a session's production ledger (plan §11 P4): ≥1 threshold-style rule or
 * candidate, ≥1 guardrail/exception confirmed, ≥1 unresolved concept surfaced, and every promoted rule
 * passes evidence validation (exact quote substring of the cited utterance, frames present and ledgered,
 * provenance). Reads only the ledger; decides nothing on the model's word.
 */
import type { Entry } from "./expert";

type Predicate = unknown;
type Quote = { kind: string; utteranceId: string; exactQuote: string; frameIds: string[]; provenance: string; t0Ms: number; t1Ms: number };
type Rule = {
  id: string;
  kind: string;
  decisionFamily: string;
  predicate: Predicate;
  effect: { type: string; action?: string; role?: string };
  evidence: Quote[];
  confirmedBy: { method: string; ledgerEntryId: string }[];
  priority: number;
  overrides: string[];
};

const NUMERIC_OPS = new Set([">", ">=", "<", "<="]);

/** Comparison operators used anywhere in a JSON-Logic predicate. */
export function comparisons(p: unknown): { op: string; var: string | undefined; value: unknown }[] {
  if (p === null || typeof p !== "object") return [];
  if (Array.isArray(p)) return p.flatMap(comparisons);
  return Object.entries(p as Record<string, unknown>).flatMap(([op, args]) => {
    if (NUMERIC_OPS.has(op) || op === "==" || op === "!=") {
      const list = Array.isArray(args) ? args : [];
      const v = list.find((a): a is { var: string } => typeof a === "object" && a !== null && "var" in a);
      const value = list.find((a) => typeof a !== "object" || a === null);
      return [{ op, var: v?.var, value }, ...list.flatMap(comparisons)];
    }
    return comparisons(args);
  });
}

export function p4Checks(ledger: readonly Entry[]) {
  const byId = new Map(ledger.map((e) => [e.id, e]));
  const confirmedEntries = ledger.filter((e) => e.kind === "rule.confirmed");
  const rules = confirmedEntries.map((e) => ({ entry: e, rule: e.payload.rule as Rule }));

  const validation = rules.map(({ entry, rule }) => {
    const problems: string[] = [];
    const quotes = rule.evidence.filter((ev) => ev.kind === "expert_quote");
    if (quotes.length === 0) problems.push("no expert quote");
    for (const q of quotes) {
      const utterance = byId.get(q.utteranceId);
      if (utterance === undefined) problems.push(`quote cites ${q.utteranceId}, not in this session's ledger`);
      else if (utterance.kind === "utterance.transcript") {
        if (utterance.source !== "voice") problems.push(`utterance source ${utterance.source}`);
        if (!String(utterance.payload.text).includes(q.exactQuote)) problems.push(`exactQuote is not a substring of utterance ${q.utteranceId}`);
      } else if (utterance.kind === "expert.statement") {
        const text = String(utterance.payload.quote ?? utterance.payload.text ?? "");
        if (!text.includes(q.exactQuote)) problems.push(`exactQuote is not a substring of typed statement ${q.utteranceId}`);
      } else problems.push(`quote cites a ${utterance.kind} entry`);
      if (q.frameIds.length === 0) problems.push("no frames");
      for (const f of q.frameIds) if (byId.get(f)?.kind !== "frame.received") problems.push(`frame ${f} is not a frame.received entry`);
      if (utterance?.source === "system_control") problems.push("quote cites a control entry");
    }
    return {
      ruleId: rule.id,
      entryId: entry.id,
      kind: rule.kind,
      effect: rule.effect,
      predicate: rule.predicate,
      method: rule.confirmedBy.map((c) => c.method),
      provenance: quotes.map((q) => q.provenance),
      quotes: quotes.map((q) => q.exactQuote),
      frames: quotes.reduce((n, q) => n + q.frameIds.length, 0),
      problems,
      valid: problems.length === 0,
    };
  });

  const thresholdRules = rules.filter(({ rule }) => comparisons(rule.predicate).some((c) => NUMERIC_OPS.has(c.op)));
  const hypothesisThresholds = ledger
    .filter((e) => e.kind === "hypotheses.updated")
    .flatMap((e) => ((e.payload.top as { predicate?: unknown; text?: string; weight?: number }[] | undefined) ?? []).map((t) => ({ entryId: e.id, ...t })))
    .filter((t) => comparisons(t.predicate).some((c) => NUMERIC_OPS.has(c.op)));
  const candidateThresholds = ledger
    .filter((e) => e.kind === "answer.parsed")
    .flatMap((e) => ((e.payload.statedRules as { predicate: unknown; exactQuote: string }[] | undefined) ?? []).map((r) => ({ entryId: e.id, ...r })))
    .filter((r) => comparisons(r.predicate).some((c) => NUMERIC_OPS.has(c.op)));
  const guardrailsOrExceptions = rules.filter(
    ({ rule }) => rule.kind === "exception" || rule.kind === "guardrail" || rule.effect.type === "forbid" || rule.effect.type === "require_approval",
  );
  const concepts = ledger.filter((e) => e.kind === "concept.proposed");
  const conceptsResolved = new Set(
    ledger.filter((e) => e.kind === "concept.confirmed" || e.kind === "concept.dismissed").map((e) => String(e.payload.name ?? e.payload.conceptName ?? "")),
  );
  // Concepts surface two ways: `concept.proposed` (the proposer after a why-probe, or vision) and the
  // answer parser's `newConcepts` (the expert named something the feature model lacks).
  const parsedConcepts = ledger
    .filter((e) => e.kind === "answer.parsed")
    .flatMap((e) => ((e.payload.newConcepts as { name: string; label: string }[] | undefined) ?? []).map((c) => ({ entryId: e.id, source: "answer.parsed", ...c })));
  const proposed = concepts.map((e) => {
    const parent = byId.get(e.parentIds[0] ?? "");
    return { entryId: e.id, source: parent?.kind === "frame.received" ? "vision (frame)" : "concept proposer", name: String(e.payload.name), label: String(e.payload.label) };
  });
  const unresolvedConcepts = [...proposed, ...parsedConcepts].filter((c) => !conceptsResolved.has(c.name));

  return {
    pass: {
      thresholdRuleOrCandidate: thresholdRules.length + hypothesisThresholds.length + candidateThresholds.length > 0,
      thresholdRuleConfirmed: thresholdRules.length > 0,
      guardrailOrExceptionConfirmed: guardrailsOrExceptions.length > 0,
      unresolvedConceptSurfaced: unresolvedConcepts.length > 0,
      everyPromotedRuleValid: validation.length > 0 && validation.every((v) => v.valid),
    },
    rulesConfirmed: validation,
    thresholdRules: thresholdRules.map(({ rule }) => ({ id: rule.id, predicate: rule.predicate, effect: rule.effect })),
    hypothesisThresholdCandidates: hypothesisThresholds.slice(0, 10),
    statedThresholdCandidates: candidateThresholds,
    guardrailsOrExceptions: guardrailsOrExceptions.map(({ rule }) => ({ id: rule.id, kind: rule.kind, effect: rule.effect, predicate: rule.predicate, quote: rule.evidence[0]?.exactQuote })),
    conceptsProposed: concepts.map((e) => e.payload),
    unresolvedConcepts: unresolvedConcepts.map((c) => `${c.name} [${c.source}]`),
    answersParsed: ledger.filter((e) => e.kind === "answer.parsed").length,
  };
}
