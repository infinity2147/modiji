import { z } from "zod";
import type { LedgerEntry } from "../schemas/ledger";
import { IdSchema } from "../schemas/primitives";
import { ConfirmedRuleSchema, type ConfirmedRule } from "../schemas/rules";
import { canonicalJson } from "./canonical";

/** Ledger kinds of the event-sourced rulebook. */
export const RULE_EVENT_KINDS = { confirmed: "rule.confirmed", revised: "rule.revised", retired: "rule.retired" } as const;

export const RuleConfirmedPayloadSchema = z.strictObject({ rule: ConfirmedRuleSchema });
/** The full new version of the rule (same id, revision = previous + 1) and why it changed. */
export const RuleRevisedPayloadSchema = z.strictObject({ rule: ConfirmedRuleSchema, reason: z.string().min(1) });
export const RuleRetiredPayloadSchema = z.strictObject({ ruleId: IdSchema, reason: z.string().min(1) });

/** Only engine derivations and the expert's own actions write rule events. */
const RULE_EVENT_SOURCES: readonly string[] = ["engine", "expert"];

export type RuleField = Exclude<keyof ConfirmedRule, "id">;

export type RulebookEvent =
  | { kind: "confirmed"; ledgerEntryId: string; ruleId: string; rulebookRevision: number; rule: ConfirmedRule }
  | { kind: "revised"; ledgerEntryId: string; ruleId: string; rulebookRevision: number; before: ConfirmedRule; after: ConfirmedRule; fields: RuleField[]; reason: string }
  | { kind: "retired"; ledgerEntryId: string; ruleId: string; rulebookRevision: number; before: ConfirmedRule; reason: string };

export type Rulebook = {
  /** Current rules, in order of first confirmation. */
  rules: ConfirmedRule[];
  /** Increments with every applied rule event (0 = empty book). */
  revision: number;
  history: RulebookEvent[];
  /** Rule events that were not applied, with why. Never silently skipped. */
  rejected: { ledgerEntryId: string; reason: string }[];
};

type RuleEventEntry = Pick<LedgerEntry, "id" | "source" | "kind" | "payload">;

/** A resumable rulebook fold: `apply` entries in ledger order; `rulebook` is the book so far. */
export type RulebookFold = {
  apply: (entry: RuleEventEntry) => void;
  /** A snapshot: later `apply` calls never change a rulebook already returned. */
  rulebook: () => Rulebook;
};

/**
 * Folds `rule.confirmed` / `rule.revised` / `rule.retired` ledger entries (in ledger order) into the
 * current rulebook, one entry at a time (`rulebookFromLedger` folds a whole list). Payloads are
 * zod-validated (so every rule carries its supporting expert quote); entries of other kinds are
 * ignored; `system_control` or other non-engine/expert sources are rejected. A confirmation must be
 * revision 1 of an id never used before; a revision must be exactly the current revision + 1 of a live
 * rule; a retirement must name a live rule.
 */
export function createRulebookFold(): RulebookFold {
  const live = new Map<string, ConfirmedRule>();
  const used = new Set<string>();
  const history: RulebookEvent[] = [];
  const rejected: Rulebook["rejected"] = [];
  let revision = 0;
  const reject = (e: { id: string }, reason: string): void => void rejected.push({ ledgerEntryId: e.id, reason });

  function apply(e: RuleEventEntry): void {
    if (e.kind !== RULE_EVENT_KINDS.confirmed && e.kind !== RULE_EVENT_KINDS.revised && e.kind !== RULE_EVENT_KINDS.retired) return;
    if (!RULE_EVENT_SOURCES.includes(e.source)) {
      reject(e, `rule events must come from the engine or the expert, not "${e.source}"`);
      return;
    }
    if (e.kind === RULE_EVENT_KINDS.confirmed) {
      const p = RuleConfirmedPayloadSchema.safeParse(e.payload);
      if (!p.success) reject(e, `invalid payload: ${z.prettifyError(p.error)}`);
      else if (used.has(p.data.rule.id)) reject(e, `rule ${p.data.rule.id} was already confirmed`);
      else if (p.data.rule.revision !== 1) reject(e, `a new rule must be revision 1, got ${p.data.rule.revision}`);
      else {
        live.set(p.data.rule.id, p.data.rule);
        used.add(p.data.rule.id);
        history.push({ kind: "confirmed", ledgerEntryId: e.id, ruleId: p.data.rule.id, rulebookRevision: ++revision, rule: p.data.rule });
      }
    } else if (e.kind === RULE_EVENT_KINDS.revised) {
      const p = RuleRevisedPayloadSchema.safeParse(e.payload);
      const before = p.success ? live.get(p.data.rule.id) : undefined;
      if (!p.success) reject(e, `invalid payload: ${z.prettifyError(p.error)}`);
      else if (before === undefined) reject(e, `rule ${p.data.rule.id} is not live`);
      else if (p.data.rule.revision !== before.revision + 1)
        reject(e, `rule ${before.id} is at revision ${before.revision}; a revision must be ${before.revision + 1}, got ${p.data.rule.revision}`);
      else {
        const after = p.data.rule;
        live.set(after.id, after);
        history.push({ kind: "revised", ledgerEntryId: e.id, ruleId: after.id, rulebookRevision: ++revision, before, after, fields: changedFields(before, after), reason: p.data.reason });
      }
    } else {
      const p = RuleRetiredPayloadSchema.safeParse(e.payload);
      const before = p.success ? live.get(p.data.ruleId) : undefined;
      if (!p.success) reject(e, `invalid payload: ${z.prettifyError(p.error)}`);
      else if (before === undefined) reject(e, `rule ${p.data.ruleId} is not live`);
      else {
        live.delete(p.data.ruleId);
        history.push({ kind: "retired", ledgerEntryId: e.id, ruleId: p.data.ruleId, rulebookRevision: ++revision, before, reason: p.data.reason });
      }
    }
  }

  return { apply, rulebook: () => ({ rules: [...live.values()], revision, history: [...history], rejected: [...rejected] }) };
}

/** The rulebook folded from `entries` (in ledger order); see `createRulebookFold`. */
export function rulebookFromLedger(entries: readonly RuleEventEntry[]): Rulebook {
  const fold = createRulebookFold();
  for (const e of entries) fold.apply(e);
  return fold.rulebook();
}

/**
 * The experts a rule belongs to (plan §7.10): its author and every expert who confirmed it. A rule two
 * experts reconciled carries both, so it is in both experts' rulebooks.
 */
export function ruleExperts(rule: Pick<ConfirmedRule, "expertId" | "confirmedBy">): string[] {
  return [...new Set([rule.expertId, ...rule.confirmedBy.map((c) => c.expertId)])];
}

/**
 * One expert's rulebook, a view of the folded (global) rulebook: the live rules the expert belongs to
 * (`ruleExperts`), and the history of the events that touched such a rule — a confirmation of one, a
 * revision whose before or after version is theirs, a retirement of one. The view renumbers its own
 * revisions (1..n), so one expert's rulebook revision moves only when their rules change. Rejected
 * events are the global book's (a rejected event never belonged to anyone's rulebook).
 */
export function expertRulebook(book: Rulebook, expertId: string): Rulebook {
  const mine = (r: ConfirmedRule): boolean => ruleExperts(r).includes(expertId);
  const touched = book.history.filter((h) =>
    h.kind === "confirmed" ? mine(h.rule) : h.kind === "revised" ? mine(h.before) || mine(h.after) : mine(h.before),
  );
  return {
    rules: book.rules.filter(mine),
    revision: touched.length,
    history: touched.map((h, i) => ({ ...h, rulebookRevision: i + 1 })),
    rejected: book.rejected,
  };
}

export type RuleDiff = {
  added: ConfirmedRule[];
  removed: ConfirmedRule[];
  changed: { id: string; before: ConfirmedRule; after: ConfirmedRule; fields: RuleField[] }[];
};

/** Rule-level and field-level difference between two rulebooks, matched by rule id (for the animated diff, plan §7.5). */
export function diffRules(before: readonly ConfirmedRule[], after: readonly ConfirmedRule[]): RuleDiff {
  const old = new Map(before.map((r) => [r.id, r]));
  const now = new Map(after.map((r) => [r.id, r]));
  const changed: RuleDiff["changed"] = [];
  for (const [id, b] of old) {
    const a = now.get(id);
    if (a === undefined) continue;
    const fields = changedFields(b, a);
    if (fields.length > 0) changed.push({ id, before: b, after: a, fields });
  }
  return {
    added: after.filter((r) => !old.has(r.id)),
    removed: before.filter((r) => !now.has(r.id)),
    changed,
  };
}

const RULE_FIELDS: readonly RuleField[] = [
  "decisionFamily",
  "kind",
  "predicate",
  "effect",
  "priority",
  "overrides",
  "evidence",
  "confirmedBy",
  "revision",
  "schemaVersion",
  "expertId",
];

function changedFields(a: ConfirmedRule, b: ConfirmedRule): RuleField[] {
  return RULE_FIELDS.filter((f) => canonicalJson(a[f]) !== canonicalJson(b[f]));
}
