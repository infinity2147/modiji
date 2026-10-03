/**
 * Deterministic plain language for the debrief: decision cells as one phrase per feature ("country
 * risk not high", "largest beneficial owner share above 25%"), rule effects, and witness questions
 * (≤25 words whenever the case allows, plan §7.2/§10). No model involved.
 */
import "server-only";
import {
  actionPhrase,
  describePredicate,
  featurePhrase,
  findFeature,
  formatValue,
  isVarRef,
  predicateNode,
  wordCount,
  type CellLiteral,
  type ConfirmedRule,
  type DomainConfig,
  type Feature,
  type Predicate,
  type RuleEffect,
  type Value,
} from "@vashistha/core";

type Bound = { value: number; strict: boolean };

/** What a cell says about one feature: allowed / excluded values, numeric bounds, or opaque conditions. */
type FeatureFacts = { equals?: Value; excluded: Value[]; oneOf?: Value[]; lower?: Bound; upper?: Bound; other: string[] };

type Literal = { feature: string; op: string; value: Value } | { feature: string; op: "in"; values: readonly Value[] };

/** A single-feature comparison or membership with literal values; undefined for anything else. */
function featureLiteral(p: Predicate): Literal | undefined {
  const node = predicateNode(p);
  if (node.key === "in") return isVarRef(node.args[0]) ? { feature: node.args[0].var, op: "in", values: node.args[1] } : undefined;
  if (node.key === "and" || node.key === "or" || node.key === "!") return undefined;
  const [l, r] = node.args;
  if (isVarRef(l) && !isVarRef(r)) return { feature: l.var, op: node.key, value: r };
  const flipped: Record<string, string> = { "<": ">", "<=": ">=", ">": "<", ">=": "<=", "==": "==", "!=": "!=" };
  if (isVarRef(r) && !isVarRef(l)) return { feature: r.var, op: flipped[node.key] ?? node.key, value: l };
  return undefined;
}

const NEGATED: Record<string, string> = { "==": "!=", "!=": "==", "<": ">=", "<=": ">", ">": "<=", ">=": "<", in: "not_in" };

function tighterLower(a: Bound | undefined, b: Bound): Bound {
  return a === undefined || b.value > a.value || (b.value === a.value && b.strict) ? b : a;
}
function tighterUpper(a: Bound | undefined, b: Bound): Bound {
  return a === undefined || b.value < a.value || (b.value === a.value && b.strict) ? b : a;
}

function collect(domain: DomainConfig, cell: readonly CellLiteral[]): Map<string, FeatureFacts> {
  const facts = new Map<string, FeatureFacts>();
  const get = (id: string): FeatureFacts => {
    const f = facts.get(id) ?? { excluded: [], other: [] };
    facts.set(id, f);
    return f;
  };
  for (const { condition, holds } of cell) {
    const lit = featureLiteral(condition);
    if (lit === undefined) {
      get("").other.push(holds ? describePredicate(condition, domain) : `not (${describePredicate(condition, domain)})`);
      continue;
    }
    const op = holds ? lit.op : (NEGATED[lit.op] ?? lit.op);
    const f = get(lit.feature);
    if ("values" in lit) {
      const { values } = lit;
      if (op === "in") f.oneOf = f.oneOf === undefined ? [...values] : f.oneOf.filter((x) => values.includes(x));
      else f.excluded.push(...values);
    } else if (op === "==") f.equals = lit.value;
    else if (op === "!=") f.excluded.push(lit.value);
    else if (typeof lit.value === "number") {
      if (op === ">" || op === ">=") f.lower = tighterLower(f.lower, { value: lit.value, strict: op === ">" });
      else f.upper = tighterUpper(f.upper, { value: lit.value, strict: op === "<" });
    }
  }
  return facts;
}

function phraseFor(f: Feature | undefined, id: string, facts: FeatureFacts): string[] {
  if (id === "") return facts.other;
  const name = f === undefined ? id : featurePhrase(f);
  const fmt = (v: Value): string => formatValue(f, v);
  if (f?.type === "boolean") {
    const value = facts.equals ?? (facts.excluded.length === 1 ? !facts.excluded[0] : undefined);
    if (typeof value === "boolean") return [`${name}: ${value ? "yes" : "no"}`];
  }
  if (facts.equals !== undefined) return [`${name} ${fmt(facts.equals)}`];
  const out: string[] = [];
  if (facts.oneOf !== undefined) out.push(`${name} ${facts.oneOf.map(fmt).join(" or ")}`);
  if (facts.excluded.length > 0) out.push(`${name} not ${[...new Set(facts.excluded)].map(fmt).join(" or ")}`);
  const { lower, upper } = facts;
  if (lower !== undefined && upper !== undefined) out.push(`${name} ${lower.strict ? "above" : "from"} ${fmt(lower.value)} ${upper.strict ? "to below" : "to"} ${fmt(upper.value)}`);
  else if (lower !== undefined) out.push(`${name} ${lower.strict ? "above" : "at least"} ${fmt(lower.value)}`);
  else if (upper !== undefined) out.push(`${name} ${upper.strict ? "below" : "at most"} ${fmt(upper.value)}`);
  return out;
}

/** One phrase per feature the cell constrains, in domain feature order (opaque conditions last). */
export function cellPhrases(domain: DomainConfig, cell: readonly CellLiteral[]): string[] {
  const facts = collect(domain, cell);
  const order = [...domain.features.map((f) => f.id as string), ""];
  return order.flatMap((id) => {
    const f = facts.get(id);
    return f === undefined ? [] : phraseFor(findFeature(domain, id), id, f);
  });
}

function capitalize(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}

/** "Send to enhanced review" / "never approve onboarding" / "get approval from a senior reviewer". */
export function effectPhrase(domain: DomainConfig, effect: RuleEffect): string {
  switch (effect.type) {
    case "recommend":
      return actionPhrase(domain, effect.action);
    case "forbid":
      return `never ${actionPhrase(domain, effect.action)}`;
    case "require_approval":
      return `get approval from a ${effect.role.replaceAll("_", " ")}`;
    case "route":
      return `route to ${effect.destination.replaceAll("_", " ")}`;
  }
}

/** A rule as "when … / then …" for cards, diffs and the teach-back template. */
export function ruleText(domain: DomainConfig, rule: Pick<ConfirmedRule, "predicate" | "effect">): { when: string; then: string } {
  return { when: describePredicate(rule.predicate, domain), then: effectPhrase(domain, rule.effect) };
}

/** Joins phrases into a spoken case description: "Customer status existing, country risk high, …". */
export function caseDescription(phrases: readonly string[]): string {
  return capitalize(phrases.join(", "));
}

/** The first candidate text of at most `maxWords` words, else the last (shortest) one. */
export function withinWords(candidates: readonly string[], maxWords: number): string {
  const fit = candidates.find((t) => wordCount(t) <= maxWords);
  return fit ?? candidates[candidates.length - 1] ?? "";
}
