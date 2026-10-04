/**
 * Client-side helpers for an expert's correction of a rule: list the numeric comparisons of a
 * predicate and rebuild it with one comparison changed. The server re-validates every predicate
 * (type check against the domain, evidence) before a revision is accepted.
 */
import { isVarRef, predicateNode, type ComparisonOp, type Predicate, type VarRef } from "@vashistha/core";

export type Path = number[];
export type NumericComparison = { path: Path; feature: string; op: ComparisonOp; value: number };

const ORDERING: readonly ComparisonOp[] = ["<", "<=", ">", ">="];

export function numericComparisons(p: Predicate, path: Path = []): NumericComparison[] {
  const node = predicateNode(p);
  if (node.key === "and" || node.key === "or" || node.key === "!") return node.args.flatMap((c, i) => numericComparisons(c, [...path, i]));
  if (node.key === "in" || !ORDERING.includes(node.key)) return [];
  const [l, r] = node.args;
  return isVarRef(l) && typeof r === "number" ? [{ path, feature: l.var, op: node.key, value: r }] : [];
}

function comparison(op: ComparisonOp, l: VarRef, value: number): Predicate {
  switch (op) {
    case "<":
      return { "<": [l, value] };
    case "<=":
      return { "<=": [l, value] };
    case ">":
      return { ">": [l, value] };
    case ">=":
      return { ">=": [l, value] };
    case "==":
      return { "==": [l, value] };
    case "!=":
      return { "!=": [l, value] };
  }
}

/** `p` with the comparison at `path` replaced by `feature op value`. */
export function replaceComparison(p: Predicate, path: Path, op: ComparisonOp, value: number): Predicate {
  const [head, ...rest] = path;
  const node = predicateNode(p);
  if (head === undefined) {
    const [l] = node.key === "and" || node.key === "or" || node.key === "!" || node.key === "in" ? [undefined] : node.args;
    if (l === undefined || !isVarRef(l)) return p;
    return comparison(op, l, value);
  }
  if (node.key === "and" || node.key === "or") {
    const args = node.args.map((c, i) => (i === head ? replaceComparison(c, rest, op, value) : c));
    const [first, ...others] = args;
    if (first === undefined) return p;
    return node.key === "and" ? { and: [first, ...others] } : { or: [first, ...others] };
  }
  if (node.key === "!") return { "!": [replaceComparison(node.args[0], rest, op, value)] };
  return p;
}

/** `p` narrowed by one more condition (conjunction), as an expert's "only when …" correction. */
export function addCondition(p: Predicate, condition: Predicate): Predicate {
  const node = predicateNode(p);
  return node.key === "and" ? { and: [...node.args, condition] } : { and: [p, condition] };
}
