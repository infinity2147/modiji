import type { FeatureId, Value } from "../schemas/primitives";
import type { ComparisonOp, Operand, Predicate } from "../schemas/predicate";

/** A predicate split into its JSON key (the operator) and its arguments. */
export type PredicateNode =
  | { key: ComparisonOp; args: [Operand, Operand] }
  | { key: "in"; args: [Operand, [Value, ...Value[]]] }
  | { key: "and" | "or"; args: [Predicate, ...Predicate[]] }
  | { key: "!"; args: [Predicate] };

export function predicateNode(p: Predicate): PredicateNode {
  if ("and" in p) return { key: "and", args: p.and };
  if ("or" in p) return { key: "or", args: p.or };
  if ("!" in p) return { key: "!", args: p["!"] };
  if ("in" in p) return { key: "in", args: p.in };
  if ("==" in p) return { key: "==", args: p["=="] };
  if ("!=" in p) return { key: "!=", args: p["!="] };
  if ("<" in p) return { key: "<", args: p["<"] };
  if ("<=" in p) return { key: "<=", args: p["<="] };
  if (">" in p) return { key: ">", args: p[">"] };
  if (">=" in p) return { key: ">=", args: p[">="] };
  throw new TypeError(`not a predicate: ${JSON.stringify(p)}`);
}

export function sortedUnique(ids: Iterable<FeatureId>): FeatureId[] {
  return [...new Set(ids)].sort();
}
