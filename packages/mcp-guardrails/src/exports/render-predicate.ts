/**
 * Deterministic plain-language rendering of a predicate tree using the domain's feature labels,
 * enum values and units, e.g. `Country risk (Northstar list) is high and Relationship age (months)
 * is at least 24 months`. Used by the Procedure export; never by any decision path.
 */
import { isVarRef, type DomainConfig, type Feature, type Operand, type Predicate, type Value } from "@vashistha/core";

type Op = "==" | "!=" | "<" | "<=" | ">" | ">=";

const PHRASE: Readonly<Record<Op, string>> = {
  "==": "is",
  "!=": "is not",
  "<": "is less than",
  "<=": "is at most",
  ">": "is more than",
  ">=": "is at least",
};

/** The operator that keeps the meaning when the operands are swapped (`5 < x` is `x > 5`). */
const MIRROR: Record<Op, Op> = { "==": "==", "!=": "!=", "<": ">", "<=": ">=", ">": "<", ">=": "<=" };

/** Collapses whitespace so domain text cannot break the surrounding markdown. */
export function inline(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

function groupDigits(n: number): string {
  const [whole = "", fraction] = String(Math.abs(n)).split(".");
  const grouped = whole.replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  return `${n < 0 ? "-" : ""}${grouped}${fraction === undefined ? "" : `.${fraction}`}`;
}

function renderValue(value: Value, feature: Feature | undefined): string {
  if (typeof value === "boolean") return value ? "yes" : "no";
  if (typeof value === "number") {
    const unit = feature?.type === "number" ? feature.unit : undefined;
    if (unit === undefined) return groupDigits(value);
    return unit === "%" ? `${groupDigits(value)}%` : `${groupDigits(value)} ${inline(unit)}`;
  }
  return feature?.type === "enum" ? inline(value) : `"${inline(value)}"`;
}

type Renderer = { feature: (id: string) => Feature | undefined };

function renderOperand(o: Operand, r: Renderer, other: Operand): string {
  if (isVarRef(o)) return inline(r.feature(o.var)?.label ?? o.var);
  return renderValue(o, isVarRef(other) ? r.feature(other.var) : undefined);
}

function renderComparison(op: Op, [left, right]: [Operand, Operand], r: Renderer): string {
  // Feature first reads naturally: "Age is at least 24", not "24 is at most Age".
  if (!isVarRef(left) && isVarRef(right)) return renderComparison(MIRROR[op], [right, left], r);
  return `${renderOperand(left, r, right)} ${PHRASE[op]} ${renderOperand(right, r, left)}`;
}

function listPhrase(items: readonly string[]): string {
  if (items.length <= 1) return items.join("");
  return `${items.slice(0, -1).join(", ")} or ${items.at(-1) ?? ""}`;
}

function render(p: Predicate, r: Renderer, parent: "and" | "or" | null): string {
  if ("and" in p || "or" in p) {
    const [key, args] = "and" in p ? (["and", p.and] as const) : (["or", p.or] as const);
    if (args.length === 1) return render(args[0], r, parent);
    const text = args.map((c) => render(c, r, key)).join(` ${key} `);
    return parent === null || parent === key ? text : `(${text})`;
  }
  if ("!" in p) return `not (${render(p["!"][0], r, null)})`;
  if ("in" in p) {
    const [operand, values] = p.in;
    const feature = isVarRef(operand) ? r.feature(operand.var) : undefined;
    const subject = isVarRef(operand) ? inline(feature?.label ?? operand.var) : renderValue(operand, undefined);
    return values.length === 1
      ? `${subject} is ${renderValue(values[0], feature)}`
      : `${subject} is one of ${listPhrase(values.map((v) => renderValue(v, feature)))}`;
  }
  if ("==" in p) return renderComparison("==", p["=="], r);
  if ("!=" in p) return renderComparison("!=", p["!="], r);
  if ("<" in p) return renderComparison("<", p["<"], r);
  if ("<=" in p) return renderComparison("<=", p["<="], r);
  if (">" in p) return renderComparison(">", p[">"], r);
  return renderComparison(">=", p[">="], r);
}

export function renderPredicate(predicate: Predicate, domain: DomainConfig): string {
  const byId = new Map<string, Feature>(domain.features.map((f) => [f.id, f]));
  return render(predicate, { feature: (id) => byId.get(id) }, null);
}
