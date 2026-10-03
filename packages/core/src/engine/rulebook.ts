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
  | { kind: "confirmed"; ledgerEntryId: string; ruleId: string; rulebookRevision: number }
  | { kind: "revised"; ledgerEntryId: string; ruleId: string; rulebookRevision: number; before: ConfirmedRule; after: ConfirmedRule; fields: RuleField[]; reason: string }
  | { kind: "retired"; ledgerEntryId: string; ruleId: string; rulebookRevision: number; reason: string };

export type Rulebook = {
  /** Current rules, in order of first confirmation. */
  rules: ConfirmedRule[];
  /** Increments with every applied rule event (0 = empty book). */
  revision: number;
  history: RulebookEvent[];
  /** Rule events that were not applied, with why. Never silently skipped. */
  rejected: { ledgerEntryId: string; reason: string }[];
};

/**
 * Folds `rule.confirmed` / `rule.revised` / `rule.retired` ledger entries (in ledger order) into the
 * current rulebook. Payloads are zod-validated (so every rule carries its supporting expert quote);
 * entries of other kinds are ignored; `system_control` or other non-engine/expert sources are
 * rejected. A confirmation must be revision 1 of an id never used before; a revision must be exactly
 * the current revision + 1 of a live rule; a retirement must name a live rule.
 */
export function rulebookFromLedger(entries: readonly Pick<LedgerEntry, "id" | "source" | "kind" | "payload">[]): Rulebook {
  const live = new Map<string, ConfirmedRule>();
  const used = new Set<string>();
  const history: RulebookEvent[] = [];
  const rejected: Rulebook["rejected"] = [];
  let revision = 0;
  const reject = (e: { id: string }, reason: string): void => void rejected.push({ ledgerEntryId: e.id, reason });

  for (const e of entries) {
    if (e.kind !== RULE_EVENT_KINDS.confirmed && e.kind !== RULE_EVENT_KINDS.revised && e.kind !== RULE_EVENT_KINDS.retired) continue;
    if (!RULE_EVENT_SOURCES.includes(e.source)) {
      reject(e, `rule events must come from the engine or the expert, not "${e.source}"`);
      continue;
    }
    if (e.kind === RULE_EVENT_KINDS.confirmed) {
      const p = RuleConfirmedPayloadSchema.safeParse(e.payload);
      if (!p.success) reject(e, `invalid payload: ${z.prettifyError(p.error)}`);
      else if (used.has(p.data.rule.id)) reject(e, `rule ${p.data.rule.id} was already confirmed`);
      else if (p.data.rule.revision !== 1) reject(e, `a new rule must be revision 1, got ${p.data.rule.revision}`);
      else {
        live.set(p.data.rule.id, p.data.rule);
        used.add(p.data.rule.id);
        history.push({ kind: "confirmed", ledgerEntryId: e.id, ruleId: p.data.rule.id, rulebookRevision: ++revision });
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
      if (!p.success) reject(e, `invalid payload: ${z.prettifyError(p.error)}`);
      else if (!live.has(p.data.ruleId)) reject(e, `rule ${p.data.ruleId} is not live`);
      else {
        live.delete(p.data.ruleId);
        history.push({ kind: "retired", ledgerEntryId: e.id, ruleId: p.data.ruleId, rulebookRevision: ++revision, reason: p.data.reason });
      }
    }
  }
  return { rules: [...live.values()], revision, history, rejected };
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
