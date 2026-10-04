import { canonicalJson } from "../engine/canonical";
import type { Value } from "../schemas/primitives";
import { isVarRef, type ComparisonOp, type Operand, type Predicate } from "../schemas/predicate";
import { predicateNode } from "./node";

/**
 * Canonical normal form of a predicate, so two ways of writing the same condition compare equal
 * (rule de-duplication). Every rewrite is an identity of strong Kleene logic that also keeps the
 * evaluator's `unknownFeatures` set and its type errors, so `evaluatePredicate(canonicalPredicate(p))`
 * equals `evaluatePredicate(p)` for every lookup (property-tested), and the form is idempotent:
 *
 * - negation is pushed to the leaves (double negation dropped; De Morgan through `and`/`or`); a negated
 *   comparison becomes its complement (`!(a < b)` → `a >= b`, `!(a == b)` → `a != b`); only a negated
 *   `in` keeps its `!`;
 * - flipped literals are normalised: a variable is written first (`5 < x` → `x > 5`), two variables (or
 *   two literals) in canonical-JSON order, and equal operands with the smaller operator (`x <= x`);
 * - `in` lists are sorted and de-duplicated;
 * - nested `and`s (and `or`s) are flattened, their children de-duplicated and sorted by canonical JSON,
 *   and a single child replaces its `and`/`or`.
 *
 * Not applied (each would change `unknownFeatures` or needs domain knowledge): absorption, `p ∧ ¬p`,
 * integer rounding of bounds, one-element `in` as `==`.
 */
export function canonicalPredicate(p: Predicate): Predicate {
  return normal(p, false);
}

/** `a OP b` ≡ `b FLIP[OP] a`. */
const FLIP: Readonly<Record<ComparisonOp, ComparisonOp>> = { "==": "==", "!=": "!=", "<": ">", "<=": ">=", ">": "<", ">=": "<=" };
/** `¬(a OP b)` ≡ `a COMPLEMENT[OP] b` (numbers are never NaN: the value schema refuses it). */
const COMPLEMENT: Readonly<Record<ComparisonOp, ComparisonOp>> = { "==": "!=", "!=": "==", "<": ">=", "<=": ">", ">": "<=", ">=": "<" };

const byJson = (a: unknown, b: unknown): number => {
  const x = canonicalJson(a);
  const y = canonicalJson(b);
  return x < y ? -1 : x > y ? 1 : 0;
};

function normal(p: Predicate, negated: boolean): Predicate {
  const node = predicateNode(p);
  switch (node.key) {
    case "!":
      return normal(node.args[0], !negated);
    case "and":
    case "or": {
      // De Morgan: a negated conjunction is the disjunction of the negated children, and vice versa.
      const key = (node.key === "and") !== negated ? "and" : "or";
      return junction(key, node.args.map((c) => normal(c, negated)));
    }
    case "in": {
      const [operand, list] = node.args;
      const values = uniqueSorted(list);
      const membership: Predicate = { in: [operand, values] };
      return negated ? { "!": [membership] } : membership;
    }
    default:
      return comparison(negated ? COMPLEMENT[node.key] : node.key, node.args[0], node.args[1]);
  }
}

function uniqueSorted(list: readonly [Value, ...Value[]]): [Value, ...Value[]] {
  const [first, ...rest] = [...new Map(list.map((v) => [canonicalJson(v), v])).values()].sort(byJson);
  if (first === undefined) throw new TypeError("an in-list is never empty");
  return [first, ...rest];
}

function comparison(op: ComparisonOp, left: Operand, right: Operand): Predicate {
  // A variable goes first; otherwise the operands go in canonical-JSON order, and equal operands take the
  // smaller of the two equivalent operators (`x <= x`, not `x >= x`).
  const order = isVarRef(left) === isVarRef(right) ? byJson(left, right) : isVarRef(left) ? -1 : 1;
  const swap = order > 0 || (order === 0 && FLIP[op] < op);
  return swap ? compare(FLIP[op], [right, left]) : compare(op, [left, right]);
}

function compare(op: ComparisonOp, args: [Operand, Operand]): Predicate {
  switch (op) {
    case "==":
      return { "==": args };
    case "!=":
      return { "!=": args };
    case "<":
      return { "<": args };
    case "<=":
      return { "<=": args };
    case ">":
      return { ">": args };
    case ">=":
      return { ">=": args };
  }
}

function junction(key: "and" | "or", children: readonly Predicate[]): Predicate {
  const flat = children.flatMap((c) => {
    const node = predicateNode(c);
    return node.key === key ? node.args : [c];
  });
  const [first, ...rest] = [...new Map(flat.map((c) => [canonicalJson(c), c])).values()].sort(byJson);
  if (first === undefined) throw new TypeError(`an ${key} always has a child`);
  if (rest.length === 0) return first;
  return key === "and" ? { and: [first, ...rest] } : { or: [first, ...rest] };
}
