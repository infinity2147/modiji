import { canonicalPredicate } from "../logic/canonical";
import { ConfirmedRuleSchema, type ConfirmedRule, type EvidenceLink } from "../schemas/rules";
import { canonicalJson } from "./canonical";
import { ruleExperts } from "./rulebook";

/**
 * Rule de-duplication. Two rules are the SAME rule when their decision family, canonical predicate
 * (`canonicalPredicate`: sorted conjunctions/disjunctions, flipped literals normalised, negation at the
 * leaves) and effect are equal: they fire on exactly the same cases with exactly the same effect.
 */
export function ruleIdentity(rule: Pick<ConfirmedRule, "decisionFamily" | "predicate" | "effect">): string {
  return canonicalJson([rule.decisionFamily, canonicalPredicate(rule.predicate), rule.effect]);
}

/**
 * What confirming `incoming` does to the rulebook (write-time de-duplication, per expert):
 *
 * - `new`: no live rule of the same expert(s) is the same rule → `rule.confirmed` of `incoming`.
 * - `merge`: the oldest such rule absorbs it → `rule.revised` of `rule` (same id, revision + 1): the
 *   new confirmations and evidence links are appended (existing ones first, so the first supporting
 *   quote is unchanged), override edges are united and the priority is the higher one. Nothing else
 *   changes, so the revised rule decides exactly what the two rules decided together.
 * - `duplicate`: `incoming` adds nothing the existing rule lacks (`absorb`: no new evidence, confirming
 *   expert, override edge or priority) — nothing to record; the caller refuses (409) or skips.
 *
 * "Same expert": the experts of the two rules (`ruleExperts`) intersect. Across different experts,
 * identical rules stay separate (each expert's rulebook keeps its own); the TEAM view merges them
 * (`teamRulebook`).
 */
export type ConfirmationPlan =
  | { kind: "new"; rule: ConfirmedRule }
  | { kind: "merge"; existing: ConfirmedRule; rule: ConfirmedRule; reason: string }
  | { kind: "duplicate"; existing: ConfirmedRule };

export function planConfirmation(live: readonly ConfirmedRule[], incoming: ConfirmedRule): ConfirmationPlan {
  const identity = ruleIdentity(incoming);
  const experts = ruleExperts(incoming);
  const existing = live.find((r) => r.id !== incoming.id && ruleIdentity(r) === identity && ruleExperts(r).some((e) => experts.includes(e)));
  if (existing === undefined) return { kind: "new", rule: incoming };
  const merged = absorb(existing, incoming);
  if (merged === undefined) return { kind: "duplicate", existing };
  const by = [...new Set(incoming.confirmedBy.map((c) => c.expertId))].join(", ");
  return { kind: "merge", existing, rule: merged, reason: `re-confirmed by ${by}: the same rule (decision family, condition and effect) as ${existing.id}` };
}

/**
 * The content of an evidence link, for "is this new evidence?": a quote is its relation, words and
 * frames (the same words over the same screen, re-submitted, add nothing); other links are what they point at.
 */
function evidenceKey(e: EvidenceLink): string {
  return e.kind === "expert_quote" ? canonicalJson([e.kind, e.relation, e.exactQuote.trim(), [...e.frameIds].sort()]) : canonicalJson(e);
}

/**
 * `into` with what `other` adds, at the next revision; undefined when it adds nothing. Something new is
 * new evidence (`evidenceKey`), a confirming expert `into` does not have yet, an override edge, or a
 * higher priority; then `other`'s confirmations are recorded too (each confirming ledger entry once).
 */
export function absorb(into: ConfirmedRule, other: ConfirmedRule): ConfirmedRule | undefined {
  const fresh = <T>(have: readonly T[], add: readonly T[], key: (t: T) => string): T[] => {
    const seen = new Set(have.map(key));
    return add.filter((t) => {
      const k = key(t);
      if (seen.has(k)) return false;
      seen.add(k);
      return true;
    });
  };
  const evidence = fresh(into.evidence, other.evidence, evidenceKey);
  const experts = fresh(into.confirmedBy, other.confirmedBy, (c) => c.expertId);
  const overrides = fresh(into.overrides, other.overrides.filter((id) => id !== into.id), (id) => id);
  const priority = Math.max(into.priority, other.priority);
  if (evidence.length === 0 && experts.length === 0 && overrides.length === 0 && priority === into.priority) return undefined;
  return ConfirmedRuleSchema.parse({
    ...into,
    priority,
    overrides: [...into.overrides, ...overrides],
    evidence: [...into.evidence, ...evidence],
    confirmedBy: [...into.confirmedBy, ...fresh(into.confirmedBy, other.confirmedBy, (c) => canonicalJson([c.expertId, c.ledgerEntryId]))],
    revision: into.revision + 1,
  });
}
